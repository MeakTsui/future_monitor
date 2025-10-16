import fetch from 'node-fetch';
import logger from './logger.js';
import { upsertSupply, getSupplyBySymbol } from './db.js';
import fs from 'fs';

const CONFIG_FILE = './config.json';
const BINANCE_TOKEN_INFO = 'https://www.binance.com/bapi/apex/v1/friendly/apex/marketing/web/token-info?symbol=';
const BINANCE_FUTURES_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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

async function fetchAndUpdateOne(symbol, minUpdateIntervalMs) {
  // 若数据库已有且未过期，跳过
  const existing = getSupplyBySymbol(symbol);
  if (existing && existing.last_updated) {
    const last = new Date(existing.last_updated).getTime();
    if (isFinite(last)) {
      const age = Date.now() - last;
      if (age < minUpdateIntervalMs) {
        logger.debug({ symbol, ageMs: age }, '跳过：更新间隔内');
        return { skipped: true, reason: 'fresh' };
      }
    }
  }
  const url = BINANCE_TOKEN_INFO + encodeURIComponent(symbol);
  const json = await fetchWithRetry(url);
  if (!json || json.code !== '000000' || json.success !== true) {
    throw new Error(`token-info 返回异常: ${JSON.stringify(json)}`);
  }
  const entry = mapTokenInfoToEntry(symbol, json);
  // 仅当同时获取到 circulating_supply 与 market_cap 时才写入
  if (entry.circulating_supply == null || entry.market_cap == null) {
    logger.debug({ symbol }, '跳过：缺少 circulating_supply 或 market_cap');
    return { skipped: true, reason: 'missing_fields' };
  }
  upsertSupply(entry);
  return { updated: 1 };
}

async function syncOnce(config) {
  const minUpdateIntervalSec = Number(config.supplyMinUpdateIntervalSec || 21600); // 默认6小时
  const minUpdateIntervalMs = minUpdateIntervalSec * 1000;
  const symbols = await fetchFuturesBaseAssets();
  let updated = 0, skipped = 0, failed = 0;
  logger.info({ total: symbols.length, minUpdateIntervalSec }, '开始增量同步 Binance token-info');

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const res = await fetchAndUpdateOne(sym, minUpdateIntervalMs);
      if (res?.updated) updated += res.updated; else skipped++;
      logger.debug({ i, sym }, '处理完成');
    } catch (e) {
      failed++;
      logger.warn({ i, sym, err: e.message }, '抓取 token-info 失败，跳过');
    }
    await new Promise(r => setTimeout(r, 400));
  }
  logger.info({ updated, skipped, failed }, '增量同步完成');
}

async function main() {
  const config = loadConfig();
  const interval = (config.supplySyncIntervalSec || 3600) * 1000;
  while (true) {
    try {
      await syncOnce(config);
    } catch (e) {
      logger.error({ err: e.message }, 'Binance token-info 同步出错');
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

main().catch(e => {
  logger.error({ err: String(e) }, 'supply_sync_binance 失败');
  process.exit(1);
});