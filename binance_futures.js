import fetch from 'node-fetch';
import logger from './logger.js';

const BASE = 'https://fapi.binance.com';
const UA = 'future_monitor/market_state';

async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;
  logger.debug({ url }, '发起 Binance 请求');
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ path, status: res.status, body: text.slice(0, 200) }, 'Binance 请求失败');
    throw new Error(`Binance GET ${path} ${res.status} ${text}`);
  }
  const json = await res.json();
  logger.debug({ path, size: Array.isArray(json) ? json.length : (json ? 1 : 0) }, 'Binance 返回成功');
  return json;
}

export async function fetch24hrAll() {
  const data = await binanceGet('/fapi/v1/ticker/24hr');
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).getTime();
  const end = start + 24 * 60 * 60 * 1000 - 1;
  const sameDay = data.filter(x => Number.isFinite(Number(x.closeTime)) && Number(x.closeTime) >= start && Number(x.closeTime) <= end);
  const filtered = sameDay.filter(x => x.symbol && x.symbol.endsWith('USDT'));
  logger.info({ total: data.length, sameDay: sameDay.length, usdt: filtered.length, start, end }, '获取 24h 行情并按当日UTC与USDT过滤');
  return filtered;
}

export async function fetchPrice(symbol) {
  const data = await binanceGet('/fapi/v1/ticker/price', { symbol });
  return Number(data.price);
}

export async function fetchKlines1m(symbol, limit = 300) {
  const data = await binanceGet('/fapi/v1/klines', { symbol, interval: '1m', limit });
  const mapped = data.map(arr => ({
    openTime: arr[0],
    open: Number(arr[1]),
    high: Number(arr[2]),
    low: Number(arr[3]),
    close: Number(arr[4]),
    volume: Number(arr[5]),
    closeTime: arr[6],
  }));
  logger.debug({ symbol, got: mapped.length }, '获取 1m K线成功');
  return mapped;
}

export async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function batchSequential(items, fn, delayMs = 100) {
  const out = [];
  logger.debug({ count: items.length, delayMs }, '开始批量顺序执行');
  for (const it of items) {
    try {
      const v = await fn(it);
      out.push([it, v, null]);
    } catch (e) {
      logger.warn({ err: String(e), it }, 'batch item failed');
      out.push([it, null, e]);
    }
    if (delayMs) await sleep(delayMs);
  }
  logger.debug({ count: out.length }, '批量顺序执行完成');
  return out;
}

export default {
  fetch24hrAll,
  fetchPrice,
  fetchKlines1m,
  batchSequential,
  sleep,
};
