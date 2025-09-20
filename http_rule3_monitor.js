import fs from "fs";
import fetch from "node-fetch";
import logger from "./logger.js";
import { getAlertState as dbGetAlertState, setAlertState as dbSetAlertState } from "./db.js";

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
    `*规则3-HTTP*: 过去 ${windowMinutes} 分钟成交额超阈值`,
    `*成交额*: ${formatCurrencyCompact(sumTurnover)}`,
  ].join('\n');

  for (const provider of (config.alerts || [])) {
    const sender = providers[provider.provider];
    if (sender) await sender(msg, provider);
  }
}

// Exchange info
async function fetchFuturesSymbols() {
  const url = "https://fapi.binance.com/fapi/v1/exchangeInfo";
  const resp = await fetch(url);
  const data = await resp.json();
  return data.symbols.filter(s => s.contractType === "PERPETUAL" && /USDT$/.test(s.symbol)).map(s => s.symbol);
}

async function fetch1mKlines(symbol, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`klines http ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("klines json not array");
  return data; // each item: [0..11], index 7 = quote volume
}

function sumQuoteVolumeUsd(klines) {
  let sum = 0;
  for (const k of klines) {
    const q = parseFloat(k[7]);
    if (Number.isFinite(q)) sum += q;
  }
  return sum;
}

class HttpRule3Monitor {
  constructor({ symbols, windowMinutes, thresholdUsd, cooldownSec, pollIntervalSec, batchSize, parallelism }) {
    this.symbols = symbols;
    this.windowMinutes = windowMinutes;
    this.thresholdUsd = thresholdUsd;
    this.cooldownSec = cooldownSec;
    this.pollIntervalSec = pollIntervalSec;
    this.batchSize = batchSize;
    this.parallelism = parallelism;
    this.cursor = 0;
    this.timer = null;
  }

  start(config) {
    const tick = async () => {
      try {
        const start = this.cursor;
        const end = Math.min(this.cursor + this.batchSize, this.symbols.length);
        const batch = this.symbols.slice(start, end);
        this.cursor = end >= this.symbols.length ? 0 : end;
        await this._processBatch(batch, config);
      } catch (e) {
        logger.warn({ err: e.message }, "HTTP Rule3 tick 异常");
      }
    };

    // 立即执行一次，再进入定时循环
    tick();
    this.timer = setInterval(tick, this.pollIntervalSec * 1000);
    logger.info({ symbols: this.symbols.length, pollIntervalSec: this.pollIntervalSec, batchSize: this.batchSize }, "HTTP Rule3 启动");
  }

  async _processBatch(batch, config) {
    // 简易并行控制
    const chunks = [];
    for (let i = 0; i < batch.length; i += this.parallelism) {
      chunks.push(batch.slice(i, i + this.parallelism));
    }
    for (const c of chunks) {
      await Promise.all(c.map(sym => this._handleSymbol(sym, config)));
      await new Promise(res => setTimeout(res, 200)); // 节流
    }
  }

  async _handleSymbol(symbol, config) {
    try {
      const kl = await fetch1mKlines(symbol, this.windowMinutes);
      const sum = sumQuoteVolumeUsd(kl);
      if (sum >= this.thresholdUsd) {
        const reason = `http_rule3_${this.windowMinutes}m_${this.thresholdUsd}`;
        const check = shouldAlert(symbol, reason, this.cooldownSec);
        if (check.ok) {
          await sendAlertNow(symbol, this.windowMinutes, sum, config);
          markAlertSent(symbol, reason);
          logger.info({ symbol, sum, window: this.windowMinutes }, "规则3-HTTP 触发并发送");
        }
      }
    } catch (e) {
      // 典型错误：429 限流、418/403 封禁、451 地理限制
      logger.debug({ symbol, err: e.message }, "获取 klines 失败");
    }
  }
}

async function main() {
  const config = loadConfig();
  if (config.logLevel) {
    try { logger.level = config.logLevel; } catch {}
  }

  const ruleCfg = config.rule3http || {};
  const windowMinutes = typeof ruleCfg.windowMinutes === 'number' ? ruleCfg.windowMinutes : 5;
  const thresholdUsd = typeof ruleCfg.turnoverUsdThreshold === 'number' ? ruleCfg.turnoverUsdThreshold : 5_000_000;
  const cooldownSec = typeof ruleCfg.cooldownSec === 'number' ? ruleCfg.cooldownSec : 1800;
  const pollIntervalSec = typeof ruleCfg.pollIntervalSec === 'number' ? ruleCfg.pollIntervalSec : 5;
  const batchSize = typeof ruleCfg.batchSize === 'number' ? ruleCfg.batchSize : 30;
  const parallelism = typeof ruleCfg.parallelism === 'number' ? ruleCfg.parallelism : 5;

  let symbols = Array.isArray(config.symbolWhitelist) && config.symbolWhitelist.length > 0
    ? config.symbolWhitelist.map(s => s.toUpperCase())
    : await fetchFuturesSymbols();

  if (!config.symbolWhitelist || config.symbolWhitelist.length === 0) {
    const limit = typeof ruleCfg.maxSymbols === 'number' ? ruleCfg.maxSymbols : 200;
    symbols = symbols.slice(0, limit);
  }

  const mon = new HttpRule3Monitor({ symbols, windowMinutes, thresholdUsd, cooldownSec, pollIntervalSec, batchSize, parallelism });
  mon.start({ alerts: config.alerts });
}

main().catch(err => {
  logger.error({ err: err.message }, "http_rule3_monitor 运行失败");
  process.exit(1);
});
