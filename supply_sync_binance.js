import fs from 'fs';
import fetch from 'node-fetch';
import logger from './logger.js';

const CONFIG_FILE = './config.json';
const SUPPLY_FILE = './supply.json';
const BINANCE_TOKEN_INFO = 'https://www.binance.com/bapi/apex/v1/friendly/apex/marketing/web/token-info?symbol=';
const BINANCE_FUTURES_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function loadExistingSupply() {
  try {
    if (fs.existsSync(SUPPLY_FILE)) {
      const raw = fs.readFileSync(SUPPLY_FILE, 'utf8');
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {
    logger.warn({ err: e.message }, '读取现有 supply.json 失败，将从空数据开始');
  }
  return {
    last_sync: null,
    data: {},
    current_sync: {
      type: null,
      started_at: null,
      symbols: [],
      index: -1,
      completed: true,
    },
  };
}

function saveSupplyIncremental(state) {
  fs.writeFileSync(SUPPLY_FILE, JSON.stringify(state, null, 2));
}

async function fetchWithRetry(url, { maxRetries = 5, initialDelayMs = 1000 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;
  while (true) {
    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'future_monitor/1.0 (+binance token-info)'
        }
      });
      if (resp.status === 429) {
        attempt++;
        if (attempt > maxRetries) throw new Error(`429 Too Many Requests after ${maxRetries} retries`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 20000);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
      }
      return await resp.json();
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 20000);
    }
  }
}

async function fetchFuturesBaseAssets() {
  const json = await fetchWithRetry(BINANCE_FUTURES_EXCHANGE_INFO);
  if (!json || !Array.isArray(json.symbols)) return [];
  const bases = json.symbols
    .filter(s => s.contractType === 'PERPETUAL')
    .map(s => s.baseAsset)
    .filter(Boolean);
  // 去重并排序，稳定顺序便于断点续传
  return Array.from(new Set(bases)).sort();
}

function parseNumber(x) {
  if (x === null || x === undefined) return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x));
  if (Number.isNaN(n)) return null;
  return n;
}

function mapTokenInfoToEntry(symbol, token) {
  const d = token?.data || {};
  return {
    symbol,
    name: d.sb || d.alias || symbol,
    circulating_supply: parseNumber(d.cs), // 流通量
    market_cap: parseNumber(d.mc), // 流通市值（冗余保存）
    total_supply: parseNumber(d.ts),
    max_supply: parseNumber(d.ms),
    volume_24h_usd: parseNumber(d.v),
    fully_diluted_market_cap: parseNumber(d.fdmc),
    rank: parseNumber(d.rk),
    last_updated: new Date().toISOString(),
  };
}

async function fetchAndUpdateOne(state, symbol) {
  const url = BINANCE_TOKEN_INFO + encodeURIComponent(symbol);
  const json = await fetchWithRetry(url);
  if (!json || json.code !== '000000' || json.success !== true) {
    throw new Error(`token-info 返回异常: ${JSON.stringify(json)}`);
  }
  const entry = mapTokenInfoToEntry(symbol, json);
  state.data[symbol] = entry;
}

async function syncOnce() {
  const state = loadExistingSupply();
  const previous = state.current_sync;
  let symbols = [];
  let continueFrom = -1;

  const continuing = previous && previous.type === 'binance_token_info' && previous.completed === false && Array.isArray(previous.symbols);
  if (continuing) {
    symbols = previous.symbols;
    continueFrom = previous.index;
    logger.info({ total: symbols.length, index: continueFrom }, '继续上次的 Binance token-info 同步');
  } else {
    symbols = await fetchFuturesBaseAssets();
    state.current_sync = {
      type: 'binance_token_info',
      started_at: new Date().toISOString(),
      symbols,
      index: -1,
      completed: false,
    };
    // 新一轮同步可选择清空或保留旧数据；为了与 monitor 一致，这里默认全量刷新
    state.data = {};
    saveSupplyIncremental(state);
    logger.info({ total: symbols.length }, '开始新的 Binance token-info 全量同步');
  }

  for (let i = continueFrom + 1; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      await fetchAndUpdateOne(state, sym);
      state.current_sync.index = i;
      saveSupplyIncremental(state);
      logger.debug({ i, sym }, '已更新 token-info');
    } catch (e) {
      logger.warn({ i, sym, err: e.message }, '抓取 token-info 失败，跳过');
    }
    // 节流，降低被限流概率
    await new Promise(r => setTimeout(r, 400));
  }

  state.current_sync.completed = true;
  state.last_sync = new Date().toISOString();
  saveSupplyIncremental(state);
  logger.info({ count: Object.keys(state.data).length }, 'Binance token-info 同步完成');
}

async function main() {
  const config = loadConfig();
  const interval = (config.supplySyncIntervalSec || 3600) * 1000;
  while (true) {
    try {
      await syncOnce();
    } catch (e) {
      logger.error({ err: e.message }, 'Binance token-info 同步出错');
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

if (process.argv[1] && process.argv[1].endsWith('supply_sync_binance.js')) {
  main();
}
