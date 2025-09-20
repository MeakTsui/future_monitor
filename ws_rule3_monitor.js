import fs from "fs";
import fetch from "node-fetch";
import WebSocket from "ws";
import logger from "./logger.js";
import { getAlertState as dbGetAlertState, setAlertState as dbSetAlertState, getAllSuppliesMap } from "./db.js";
import http from "http";
import { dispatchAlert, buildAlertPayload } from "./alerting.js";

// Config
const CONFIG_FILE = "./config.json";
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// Symbol helpers（从合约符号映射到 supply 表的基础币符号）
function normalizeBaseSymbolFromContract(sym) {
  // 输入：ETHUSDT, 1000SHIBUSDT, BNBUPUSDT, XRPBULLUSDT
  let base = sym;
  base = base.replace(/(USDT|BUSD|USDC)$/i, "");
  base = base.replace(/(UP|DOWN|BULL|BEAR)$/i, "");
  base = base.replace(/^(\d{3,})/, "");
  return base.toUpperCase();
}

function findSupplyForSymbol(supplyMap, contractSymbol) {
  if (!supplyMap) return null;
  const direct = normalizeBaseSymbolFromContract(contractSymbol);
  if (supplyMap[direct]) return { key: direct, supply: supplyMap[direct] };
  return null;
}

// 发送统一走 alerting 模块（Console/Telegram 仍文本，Webhook 为结构化）

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

// 进程内短期冷却，减少并发下的重复告警
const inMemoryCooldown = new Map(); // key -> lastAtMs
function shouldAlertLocal(symbol, reason, cooldownSec) {
  const key = makeAlertKey(symbol, reason);
  const now = Date.now();
  const last = inMemoryCooldown.get(key) || 0;
  if (now - last < cooldownSec * 1000) {
    const remaining = Math.ceil((cooldownSec * 1000 - (now - last)) / 1000);
    return { ok: false, reason: 'local_cooldown', remainingSec: remaining };
  }
  return { ok: true };
}
function markAlertSentLocal(symbol, reason) {
  const key = makeAlertKey(symbol, reason);
  inMemoryCooldown.set(key, Date.now());
}

async function sendAlertNow(symbol, windowMinutes, sumTurnover, config, extras = {}) {
  const {
    reasonLine, // 例如: 市值低于$500.00M且15m成交额超过$5.00M
    trendEmoji, // 📈/📉/➖
    marketCap,  // number | undefined
    ratio,      // number | undefined (成交额/市值)
    prevClose,  // number | undefined
    closePrice, // number | undefined
    deltaPct,   // number | undefined (0.0158 表示 +1.58%)
  } = extras;

  const lines = [];
  // 标题行（不加链接，按需求显示 symbol + emoji）
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  lines.push(`‼️‼️${link} ${trendEmoji || ''}`.trim());
  if (reasonLine) lines.push(`原因: ${reasonLine}`);
  lines.push(`成交量(USD): ${formatCurrencyCompact(sumTurnover)}`);
  if (typeof marketCap === 'number' && Number.isFinite(marketCap)) {
    lines.push(`市值: ${formatCurrencyCompact(marketCap)}`);
  }
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    const digits = ratio < 0.01 ? 4 : 2; // 很小的倍数用更高精度
    lines.push(`倍数: ${formatNumber(ratio, digits)}`);
  }
  if (typeof prevClose === 'number' && Number.isFinite(prevClose) && typeof closePrice === 'number' && Number.isFinite(closePrice)) {
    const pctText = (typeof deltaPct === 'number' && Number.isFinite(deltaPct))
      ? ` (${deltaPct >= 0 ? '+' : ''}${formatNumber(deltaPct * 100)}%)`
      : '';
    lines.push(`价格: ${formatCurrency(prevClose)} → ${formatCurrency(closePrice)}${pctText} ${trendEmoji || ''}`.trim());
  }

  const msg = lines.join('\n');

  // 结构化 payload（Webhook 使用，含 text 以兼容）
  const payload = buildAlertPayload({
    strategy: 'rule3_ws',
    symbol,
    reason: reasonLine,
    windowMinutes,
    severity: 'warning',
    metrics: {
      sumTurnover,
      marketCap,
      ratio,
      prevClose,
      closePrice,
      deltaPct,
    },
    links: { binanceFutures: buildBinanceFuturesUrl(symbol) },
    tags: ['ws', 'rule3'],
  });

  await dispatchAlert({ config, text: msg, payload });
}

// Exchange info
async function fetchFuturesSymbols(restBaseUrl) {
  const base = restBaseUrl || "https://fapi.binance.com";
  const url = `${base}/fapi/v1/exchangeInfo`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, "获取 exchangeInfo 失败");
      return [];
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.symbols)) {
      logger.warn({ url }, "exchangeInfo 返回异常结构");
      return [];
    }
    return data.symbols.filter(s => s.contractType === "PERPETUAL" && /USDT$/.test(s.symbol)).map(s => s.symbol);
  } catch (e) {
    logger.warn({ url, err: e.message }, "获取 exchangeInfo 异常");
    return [];
  }
}

// WS manager for multiple symbols (combined stream)
class KlineAggregator {
  constructor({ symbols, windowMinutes, thresholdUsd, cooldownSec, maxPerSocket = 80, wsBaseUrl = "wss://fstream.binance.com", heartbeatSec = 120, rotateHours = 23, marketCapMaxUsd = 0, supplyMap = null }) {
    this.symbols = symbols;
    this.windowMinutes = windowMinutes;
    this.thresholdUsd = thresholdUsd;
    this.cooldownSec = cooldownSec;
    this.maxPerSocket = maxPerSocket;
    this.wsBaseUrl = wsBaseUrl;
    this.heartbeatSec = heartbeatSec;
    this.rotateHours = rotateHours;
    this.marketCapMaxUsd = marketCapMaxUsd; // <=0 表示不启用市值过滤
    this.supplyMap = supplyMap;
    this.streams = []; // { ws, streamSymbols, backoffMs }
    // per-symbol rolling buckets: Map<symbol, Map<bucketStartMs, quoteVolUsd>>
    this.buckets = new Map();
    // 记录每个symbol上一次触发的分钟桶，避免同一分钟内重复告警
    this.lastBucketSent = new Map(); // symbol -> bucketStartMs
    // 记录最新价格（用于调试与价格变动）
    this.lastClosePrice = new Map(); // symbol -> last price (may be intra-minute)
    this.lastClosedPrice = new Map(); // symbol -> last closed kline close
    this.prevClosedPrice = new Map(); // symbol -> previous closed kline close
    // 策略插件：按需注册自定义策略，签名为 (ctx, config, helpers) => Promise<void> | void
    this.strategies = [];
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
        const closeStr = k.c; // 收盘价字符串
        const closePrice = parseFloat(closeStr);
        // 更新价格缓存
        if (Number.isFinite(closePrice)) {
          this.lastClosePrice.set(symbol, closePrice);
          if (isClosed) {
            const lastClosed = this.lastClosedPrice.get(symbol);
            if (Number.isFinite(lastClosed)) this.prevClosedPrice.set(symbol, lastClosed);
            this.lastClosedPrice.set(symbol, closePrice);
          }
        }
        this._updateBucket(symbol, openTime, quoteVol, isClosed);
        // compute rolling sum
        const nowMs = Date.now();
        const sum = this._sumLastMinutes(symbol, nowMs, this.windowMinutes);
        if (sum >= this.thresholdUsd) {
          const ctx = this._buildContextForStrategies({ symbol, openTime, sum, closePrice });
          // 若已注册自定义策略，则依次执行；否则使用内置默认策略
          if (this.strategies.length > 0) {
            for (const fn of this.strategies) {
              try { fn(ctx, config, this._helpers()); } catch (e) { logger.warn({ err: e.message }, '自定义策略执行异常'); }
            }
          } else {
            this._evaluateDefaultStrategy(ctx, config);
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
      // 主动关闭让 close 逻辑接管重连与清理
      try { ws.close(); } catch {}
    });

    ws.on("close", () => {
      logger.warn({ url, backoffMs }, "WS 连接关闭，准备重连");
      if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
      if (state.rotateTimer) { clearTimeout(state.rotateTimer); state.rotateTimer = null; }
      // 从活动列表移除，防止内存泄漏
      const idx = this.streams.indexOf(state);
      if (idx !== -1) this.streams.splice(idx, 1);
      // 指数退避 + 抖动，避免同时重连引发尖峰
      const nextBackoff = Math.min(backoffMs * 2, 60_000);
      const jitter = Math.floor(Math.random() * Math.max(100, Math.floor(nextBackoff * 0.3)));
      const wait = Math.max(500, backoffMs + jitter);
      setTimeout(() => {
        this._openSocket(streamSymbols, config, nextBackoff);
      }, wait);
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

  _buildContextForStrategies({ symbol, openTime, sum, closePrice }) {
    // 市值（如果可能）
    let marketCap, supplyKey, circulating;
    const sf = findSupplyForSymbol(this.supplyMap, symbol);
    if (sf && sf.supply && typeof sf.supply.circulating_supply === 'number' && Number.isFinite(closePrice)) {
      supplyKey = sf.key;
      circulating = sf.supply.circulating_supply;
      marketCap = closePrice * circulating;
    }

    // 价格与趋势
    const lastClosed = this.lastClosedPrice.get(symbol);
    const prevClosed = this.prevClosedPrice.get(symbol);
    let prevForDisplay = prevClosed;
    let closeForDisplay = lastClosed;
    let deltaPct;
    if (Number.isFinite(lastClosed) && Number.isFinite(prevClosed) && prevClosed > 0) {
      deltaPct = (lastClosed - prevClosed) / prevClosed;
    } else if (Number.isFinite(lastClosed) && Number.isFinite(this.lastClosePrice.get(symbol)) && lastClosed > 0) {
      const live = this.lastClosePrice.get(symbol);
      prevForDisplay = lastClosed;
      closeForDisplay = live;
      if (Number.isFinite(live)) {
        deltaPct = (live - lastClosed) / lastClosed;
      }
    }
    const trendEmoji = (typeof deltaPct === 'number') ? (deltaPct > 0 ? '📈' : (deltaPct < 0 ? '📉' : '➖')) : '';

    return {
      symbol,
      openTime,
      sumTurnover: sum,
      closePrice,
      marketCap,
      supplyKey,
      circulating,
      lastClosed,
      prevClosed,
      prevForDisplay,
      closeForDisplay,
      deltaPct,
      trendEmoji,
    };
  }

  _helpers() {
    return {
      windowMinutes: this.windowMinutes,
      thresholdUsd: this.thresholdUsd,
      marketCapMaxUsd: this.marketCapMaxUsd,
      cooldownSec: this.cooldownSec,
      shouldAlertLocal,
      shouldAlert,
      markAlertSentLocal,
      markAlertSent,
      buildReasonLine: () => (this.marketCapMaxUsd > 0)
        ? `市值低于${formatCurrencyCompact(this.marketCapMaxUsd)}且${this.windowMinutes}m成交额超过${formatCurrencyCompact(this.thresholdUsd)}`
        : `${this.windowMinutes}m成交额超过${formatCurrencyCompact(this.thresholdUsd)}`,
      notify: async (symbol, reasonLine, sumTurnover, config, extras = {}) => {
        await sendAlertNow(symbol, this.windowMinutes, sumTurnover, config, { reasonLine, ...extras });
      },
    };
  }

  async _evaluateDefaultStrategy(ctx, config) {
    const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;
    const reason = `ws_rule3_${this.windowMinutes}m_${this.thresholdUsd}`;
    // 同一分钟桶内避免重复
    const lastSentBucket = this.lastBucketSent.get(symbol);
    if (lastSentBucket === openTime) return;

    // 市值过滤
    if (this.marketCapMaxUsd > 0) {
      if (!Number.isFinite(marketCap)) {
        logger.debug({ symbol }, '规则3-WS 跳过：缺少 supply 数据，无法计算市值');
        return;
      }
      if (!(marketCap > 0 && marketCap < this.marketCapMaxUsd)) return;
    }

    // 冷却
    const local = shouldAlertLocal(symbol, reason, this.cooldownSec);
    if (!local.ok) {
      logger.debug({ symbol, reason: local.reason, remainingSec: local.remainingSec }, '规则3-WS 本地冷却抑制');
      return;
    }
    const check = shouldAlert(symbol, reason, this.cooldownSec);
    if (!check.ok) {
      logger.debug({ symbol, reason: check.reason, remainingSec: check.remainingSec }, '规则3-WS DB冷却抑制');
      return;
    }

    // 标记，避免并发重复
    markAlertSentLocal(symbol, reason);
    markAlertSent(symbol, reason);
    this.lastBucketSent.set(symbol, openTime);

    const reasonLine = (this.marketCapMaxUsd > 0)
      ? `市值低于${formatCurrencyCompact(this.marketCapMaxUsd)}且${this.windowMinutes}m成交额超过${formatCurrencyCompact(this.thresholdUsd)}`
      : `${this.windowMinutes}m成交额超过${formatCurrencyCompact(this.thresholdUsd)}`;
    const ratio = (typeof marketCap === 'number' && marketCap > 0) ? (sumTurnover / marketCap) : undefined;

    try {
      await sendAlertNow(symbol, this.windowMinutes, sumTurnover, config, {
        reasonLine,
        trendEmoji,
        marketCap,
        ratio,
        prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
        closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
        deltaPct
      });
      logger.info({ symbol, sum: sumTurnover, window: this.windowMinutes }, "规则3-WS 触发并发送");
    } catch (err) {
      logger.warn({ symbol, err: err.message }, '规则3-WS 发送失败');
    }
  }

  // 对外：注册策略
  use(strategyFn) {
    if (typeof strategyFn === 'function') this.strategies.push(strategyFn);
  }

  // 调试：返回指定 symbol 的当前计算与规则判定信息（只读，不会触发告警）
  inspectSymbol(symbol) {
    const nowMs = Date.now();
    const sum = this._sumLastMinutes(symbol, nowMs, this.windowMinutes);
    const map = this.buckets.get(symbol) || new Map();
    const buckets = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([openTime, quoteVol]) => ({ openTime, quoteVol }));

    const latestOpenTime = buckets.length ? buckets[buckets.length - 1].openTime : null;
    const lastSentBucket = this.lastBucketSent.get(symbol) || null;

    const reason = `ws_rule3_${this.windowMinutes}m_${this.thresholdUsd}`;
    const local = shouldAlertLocal(symbol, reason, this.cooldownSec);
    const db = shouldAlert(symbol, reason, this.cooldownSec);

    let marketCapInfo = null;
    if (this.marketCapMaxUsd > 0) {
      const closePrice = this.lastClosePrice.get(symbol);
      const sf = findSupplyForSymbol(this.supplyMap, symbol);
      if (sf && sf.supply && typeof sf.supply.circulating_supply === 'number' && Number.isFinite(closePrice)) {
        const marketCap = closePrice * sf.supply.circulating_supply;
        marketCapInfo = {
          supplyKey: sf.key,
          circulating: sf.supply.circulating_supply,
          closePrice,
          marketCap,
          max: this.marketCapMaxUsd,
          pass: (marketCap > 0 && marketCap < this.marketCapMaxUsd)
        };
      } else {
        marketCapInfo = { supplyFound: !!sf, closePrice, pass: false, reason: 'missing_supply_or_price' };
      }
    }

    const wouldDuplicate = (lastSentBucket !== null && latestOpenTime !== null && lastSentBucket === latestOpenTime);
    const thresholdPass = sum >= this.thresholdUsd;
    const mcPass = (this.marketCapMaxUsd <= 0) || (marketCapInfo && marketCapInfo.pass);
    const wouldTriggerNow = thresholdPass && mcPass && local.ok && db.ok && !wouldDuplicate;

    const result = {
      symbol,
      windowMinutes: this.windowMinutes,
      thresholdUsd: this.thresholdUsd,
      cooldownSec: this.cooldownSec,
      now: nowMs,
      sumTurnoverUsd: sum,
      buckets,
      latestOpenTime,
      lastSentBucket,
      localCooldown: local,
      dbCooldown: db,
      marketCap: marketCapInfo,
      evaluation: {
        thresholdPass,
        mcPass,
        wouldDuplicate,
        wouldTriggerNow
      }
    };

    // 中文解释（用()包裹），不改变原字段，便于人类阅读
    result.notes = {
      symbol: '交易对(symbol)',
      windowMinutes: '滚动窗口分钟数(windowMinutes)',
      thresholdUsd: '成交额阈值(USD)(thresholdUsd)',
      cooldownSec: '告警冷却时长(秒)(cooldownSec)',
      now: '当前服务器时间戳(毫秒)(now)',
      sumTurnoverUsd: '过去窗口内成交额合计(USDT)(sumTurnoverUsd)',
      buckets: '分钟桶列表(开盘时间openTime与该分钟USDT成交额quoteVol)(buckets)',
      latestOpenTime: '最近分钟桶开始时间(毫秒)(latestOpenTime)',
      lastSentBucket: '上次触发告警的分钟桶开始时间(毫秒)(lastSentBucket)',
      localCooldown: '本地冷却检查结果(localCooldown)',
      dbCooldown: '数据库冷却检查结果(dbCooldown)',
      marketCap: '市值过滤评估信息(marketCap)',
      evaluation: '规则评估汇总(evaluation)'
    };

    return result;
  }
}

function buildBinanceFuturesUrl(contractSymbol) {
  // 直接跳转 USDT 永续合约页面
  // Binance 会根据设备/客户端引导打开 App
  return `https://www.binance.com/en/futures/${contractSymbol}`;
}

// 调试：启动一个简易的 HTTP 服务，提供调试信息
function startDebugServer(agg, port = 18081) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/debug') {
        const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
        if (!symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing symbol' }));
          return;
        }
        if (!agg.symbols.includes(symbol)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'symbol not tracked', symbol }));
          return;
        }
        const info = agg.inspectSymbol(symbol);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(port, () => {
    logger.info({ port }, '调试接口已启动：GET /debug?symbol=SYMBOL');
  });
  return server;
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
  const marketCapMaxUsd = typeof ruleCfg.marketCapMaxUsd === 'number' ? ruleCfg.marketCapMaxUsd : 500_000_000;
  const debugPort = typeof ruleCfg.debugPort === 'number' ? ruleCfg.debugPort : 18081;

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

  // 载入供给数据（SQLite），用于市值过滤
  let supplyMap = null;
  try { supplyMap = getAllSuppliesMap(); } catch (e) { logger.warn({ err: e.message }, '加载 supply 数据失败'); }

  const agg = new KlineAggregator({ symbols, windowMinutes, thresholdUsd, cooldownSec, maxPerSocket, wsBaseUrl: wsBaseUrl || undefined, heartbeatSec, rotateHours, marketCapMaxUsd, supplyMap });

  // 动态加载自定义策略：config.rule3ws.wsStrategies = ["./strategies/myStrategy.js", ...]
  const wsStrategies = Array.isArray(ruleCfg.wsStrategies) ? ruleCfg.wsStrategies : [];
  for (const modPath of wsStrategies) {
    try {
      const m = await import(modPath);
      const fn = m.default || m.strategy || m.handle || m.run;
      if (typeof fn === 'function') {
        agg.use(fn);
        logger.info({ modPath }, '已注册自定义 WS 策略');
      } else {
        logger.warn({ modPath }, '自定义 WS 策略模块未导出函数，已跳过');
      }
    } catch (e) {
      logger.warn({ modPath, err: e.message }, '加载自定义 WS 策略失败');
    }
  }

  // 启动调试接口
  startDebugServer(agg, debugPort);
  agg.start({ alerts: config.alerts });
}

main().catch(err => {
  logger.error({ err: err.message }, "ws_rule3_monitor 运行失败");
  process.exit(1);
});
