import fs from "fs";
import fetch from "node-fetch";
import WebSocket from "ws";
import logger from "./logger.js";
import { getAlertState as dbGetAlertState, setAlertState as dbSetAlertState } from "./db.js";

// Config
const CONFIG_FILE = "./config.json";
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// Providers (reuse minimal senders)
async function sendConsole(message) {
  logger.info(message);
}

async function sendTelegram(message, providerConfig) {
  const url = `https://api.telegram.org/bot${providerConfig.botToken}/sendMessage`;
  const body = {
    chat_id: providerConfig.chatId,
    text: message,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    if (!result.ok) {
      logger.error({ result }, "发送 Telegram 失败");
    }
  } catch (err) {
    logger.error({ err: err.message }, "发送 Telegram 出错");
  }
}

async function sendWebhook(message, providerConfig) {
  try {
    const resp = await fetch(providerConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status, text: await resp.text() }, "Webhook 推送失败");
    }
  } catch (err) {
    logger.error({ err: err.message }, "Webhook 推送出错");
  }
}

const providers = {
  console: sendConsole,
  telegram: sendTelegram,
  webhook: sendWebhook,
};

// Helpers
function formatNumber(n, digits = 2) {
  if (typeof n !== "number" || isNaN(n)) return String(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function formatCurrency(n, digits = 2) {
  if (typeof n !== "number" || isNaN(n)) return String(n);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function formatCurrencyCompact(n, digits = 2) {
  if (typeof n !== "number" || isNaN(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const fmt = (v, suffix = '') => `${sign}$${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
  if (abs >= 1e12) return fmt(abs / 1e12, 'T');
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'K');
  return fmt(abs, '');
}

function buildBinanceFuturesUrl(contractSymbol) {
  return `https://www.binance.com/en/futures/${contractSymbol}`;
}

// Cooldown & dedupe
function makeAlertKey(symbol, reason) {
  return `${symbol}|${reason}`;
}
function shouldAlert(symbol, reason, cooldownSec) {
  const key = makeAlertKey(symbol, reason);
  const row = dbGetAlertState(key);
  const now = Date.now();
  if (row && row.last_at && now - row.last_at < cooldownSec * 1000) {
    const remainingMs = row.last_at + cooldownSec * 1000 - now;
    return { ok: false, reason: "cooldown", remainingSec: Math.ceil(remainingMs / 1000) };
  }
  return { ok: true };
}
function markAlertSent(symbol, reason) {
  const key = makeAlertKey(symbol, reason);
  dbSetAlertState(key, Date.now(), null);
}

async function sendAlertNow(symbol, windowMinutes, sumTurnover, config) {
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  const msg = [
    `‼️‼️${link}`,
    `*规则3-WS*: 过去 ${windowMinutes} 分钟成交额超阈值`,
    `*成交额*: ${formatCurrencyCompact(sumTurnover)}`,
  ].join('\n');

  for (const provider of (config.alerts || [])) {
    const sender = providers[provider.provider];
    if (sender) await sender(msg, provider);
  }
}

// Exchange info
async function fetchFuturesSymbols(restBaseUrl) {
  const base = restBaseUrl || "https://fapi.binance.com";
  const url = `${base}/fapi/v1/exchangeInfo`;
  const resp = await fetch(url);
  const data = await resp.json();
  return data.symbols.filter(s => s.contractType === "PERPETUAL" && /USDT$/.test(s.symbol)).map(s => s.symbol);
}

// WS manager for multiple symbols (combined stream)
class KlineAggregator {
  constructor({ symbols, windowMinutes, thresholdUsd, cooldownSec, maxPerSocket = 80, wsBaseUrl = "wss://fstream.binance.com", heartbeatSec = 120, rotateHours = 23 }) {
    this.symbols = symbols;
    this.windowMinutes = windowMinutes;
    this.thresholdUsd = thresholdUsd;
    this.cooldownSec = cooldownSec;
    this.maxPerSocket = maxPerSocket;
    this.wsBaseUrl = wsBaseUrl;
    this.heartbeatSec = heartbeatSec;
    this.rotateHours = rotateHours;
    this.streams = []; // { ws, streamSymbols, backoffMs }
    // per-symbol rolling buckets: Map<symbol, Map<bucketStartMs, quoteVolUsd>>
    this.buckets = new Map();
  }

  start(config) {
    // split symbols into chunks, stagger connection establishment to reduce handshake bursts
    let idx = 0;
    for (let i = 0; i < this.symbols.length; i += this.maxPerSocket) {
      const chunk = this.symbols.slice(i, i + this.maxPerSocket);
      const delay = 500 * idx; // 逐个错峰，避免同时握手
      setTimeout(() => this._openSocket(chunk, config), delay);
      idx++;
    }
    logger.info({ planSockets: idx, symbols: this.symbols.length }, "WS Rule3 启动中（分批建立连接）");
  }

  _openSocket(streamSymbols, config, backoffMs = 1000) {
    const streams = streamSymbols.map(s => `${s.toLowerCase()}@kline_1m`).join("/");
    const url = `${this.wsBaseUrl}/stream?streams=${streams}`;
    const ws = new WebSocket(url);

    const state = { ws, streamSymbols, backoffMs, url, heartbeat: null, rotateTimer: null };
    this.streams.push(state);

    ws.on("open", () => {
      logger.info({ url }, "WS 已连接");
      // 客户端心跳：每120秒发送一次 ping（空payload），遵循“未经请求的pong可接受但不保证不断开”的建议
      // 服务器会每3分钟发送ping，我们也主动ping以穿透NAT/代理
      try {
        state.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch (e) { logger.debug({ err: e.message }, '发送ping失败'); }
          }
        }, Math.max(30, this.heartbeatSec) * 1000);
      } catch {}
      // 连接生命周期轮换：默认23小时内重连一次（服务端24小时自动断开）
      const lifeMs = Math.max(1, this.rotateHours) * 60 * 60 * 1000;
      state.rotateTimer = setTimeout(() => {
        try { logger.info({ url }, '到达生命周期，主动重连'); ws.close(); } catch {}
      }, lifeMs);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (!msg || !msg.data || !msg.data.k) return;
        const k = msg.data.k; // kline
        const symbol = k.s; // e.g. BTCUSDT
        // quote asset volume in this minute (USDT)
        const quoteVol = parseFloat(k.q) || 0;
        const openTime = k.t; // ms bucket start
        const isClosed = !!k.x;
        this._updateBucket(symbol, openTime, quoteVol, isClosed);
        // compute rolling sum
        const sum = this._sumLastMinutes(symbol, Date.now(), this.windowMinutes);
        if (sum >= this.thresholdUsd) {
          const reason = `ws_rule3_${this.windowMinutes}m_${this.thresholdUsd}`;
          const check = shouldAlert(symbol, reason, this.cooldownSec);
          if (check.ok) {
            sendAlertNow(symbol, this.windowMinutes, sum, config).then(() => {
              markAlertSent(symbol, reason);
              logger.info({ symbol, sum, window: this.windowMinutes }, "规则3-WS 触发并发送");
            });
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, "WS 消息处理异常");
      }
    });

    // 服务器 ping：立即回 pong，payload需一致
    ws.on('ping', (data) => {
      try { ws.pong(data); } catch (e) { logger.debug({ err: e.message }, '回复pong失败'); }
    });

    ws.on("error", (err) => {
      logger.error({ url, err: err.message }, "WS 错误");
    });

    ws.on("close", () => {
      logger.warn({ url, backoffMs }, "WS 连接关闭，准备重连");
      if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
      if (state.rotateTimer) { clearTimeout(state.rotateTimer); state.rotateTimer = null; }
      setTimeout(() => {
        const nextBackoff = Math.min(backoffMs * 2, 60_000);
        this._openSocket(streamSymbols, config, nextBackoff);
      }, backoffMs);
    });
  }

  _updateBucket(symbol, bucketStartMs, quoteVol, isClosed) {
    if (!this.buckets.has(symbol)) this.buckets.set(symbol, new Map());
    const map = this.buckets.get(symbol);
    map.set(bucketStartMs, quoteVol);
    // 清理过旧的桶
    const now = Date.now();
    const cutoff = now - this.windowMinutes * 60_000 - 60_000; // 额外留1分钟保证覆盖
    for (const key of map.keys()) {
      if (key < cutoff) map.delete(key);
    }
  }

  _sumLastMinutes(symbol, nowMs, windowMinutes) {
    const map = this.buckets.get(symbol);
    if (!map) return 0;
    const start = nowMs - windowMinutes * 60_000;
    let sum = 0;
    for (const [bucketStart, q] of map.entries()) {
      if (bucketStart >= start) sum += q || 0;
    }
    return sum;
  }
}

async function main() {
  const config = loadConfig();
  if (config.logLevel) {
    try { logger.level = config.logLevel; } catch {}
  }

  const ruleCfg = config.rule3ws || {};
  const windowMinutes = typeof ruleCfg.windowMinutes === 'number' ? ruleCfg.windowMinutes : 5;
  const thresholdUsd = typeof ruleCfg.turnoverUsdThreshold === 'number' ? ruleCfg.turnoverUsdThreshold : 5_000_000;
  const cooldownSec = typeof ruleCfg.cooldownSec === 'number' ? ruleCfg.cooldownSec : 1800;
  const maxPerSocket = typeof ruleCfg.maxPerSocket === 'number' ? ruleCfg.maxPerSocket : 80;
  const restBaseUrl = typeof ruleCfg.restBaseUrl === 'string' && ruleCfg.restBaseUrl ? ruleCfg.restBaseUrl : undefined;
  const wsBaseUrl = typeof ruleCfg.wsBaseUrl === 'string' && ruleCfg.wsBaseUrl ? ruleCfg.wsBaseUrl : undefined;
  const heartbeatSec = typeof ruleCfg.heartbeatSec === 'number' ? ruleCfg.heartbeatSec : 120;
  const rotateHours = typeof ruleCfg.rotateHours === 'number' ? ruleCfg.rotateHours : 23;

  let symbols = Array.isArray(config.symbolWhitelist) && config.symbolWhitelist.length > 0
    ? config.symbolWhitelist.map(s => s.toUpperCase())
    : await fetchFuturesSymbols(restBaseUrl);

  // 为了稳定，若未指定白名单，可限制订阅数量（maxSymbols=0 表示不裁剪）
  if (!config.symbolWhitelist || config.symbolWhitelist.length === 0) {
    const limit = typeof ruleCfg.maxSymbols === 'number' ? ruleCfg.maxSymbols : 60;
    if (limit > 0) {
      symbols = symbols.slice(0, limit);
    }
  }

  const agg = new KlineAggregator({ symbols, windowMinutes, thresholdUsd, cooldownSec, maxPerSocket, wsBaseUrl: wsBaseUrl || undefined, heartbeatSec, rotateHours });
  agg.start({ alerts: config.alerts });
}

main().catch(err => {
  logger.error({ err: err.message }, "ws_rule3_monitor 运行失败");
  process.exit(1);
});
