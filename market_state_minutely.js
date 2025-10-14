import logger from './logger.js';
import {
  upsertMarketStateMinute,
  upsertMarketStateSymbolMinute,
  getUniverseByDate,
  saveUniverse,
  getLatestUniverseSnapshotBefore,
  getAvgVolMapForLatestHourBefore
} from './db.js';
import {
  fetch24hrAll,
  fetchKlines1m,
  batchSequential,
  sleep
} from './binance_futures.js';

function toDateStrUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function floorToMinuteUTCms(d) {
  const t = new Date(d);
  t.setUTCSeconds(0, 0);
  return t.getTime();
}

function minuteDiff(aMs, bMs) {
  return Math.floor((aMs - bMs) / 60000);
}

function byQuoteVolumeDesc(a, b) {
  const av = Number(a.quoteVolume || 0);
  const bv = Number(b.quoteVolume || 0);
  return bv - av;
}

async function getOrBuildDailyUniverse(tsMinuteISO) {
  const dateStr = toDateStrUTC(new Date(tsMinuteISO));
  const exist = getUniverseByDate(dateStr);
  if (exist && Array.isArray(exist.selected_51_130) && exist.selected_51_130.length > 0) {
    logger.debug({ date: dateStr, count: exist.selected_51_130.length }, '使用已存在的当日 Universe');
    return exist.selected_51_130;
  }
  const all = await fetch24hrAll();
  const filtered = all.filter(x => x.symbol && x.symbol.endsWith('USDT') && x.symbol !== 'ETHUSDT' && x.symbol !== 'SOLUSDT');
  filtered.sort(byQuoteVolumeDesc);
  const selected = filtered.slice(50, 130).map(x => x.symbol);
  await saveUniverse({ date: dateStr, symbols_ranked: filtered.map(x => x.symbol), selected_51_130: selected });
  logger.info({ date: dateStr, ranked: filtered.length, selected: selected.length }, '已生成当日 Universe');
  return selected;
}

const priceWindows = new Map();

function ensureWindowMap(key) {
  if (!priceWindows.has(key)) priceWindows.set(key, []);
  return priceWindows.get(key);
}

function pushOrReplaceLast(arr, kline) {
  if (arr.length === 0) {
    arr.push(kline);
    return;
  }
  const last = arr[arr.length - 1];
  if (kline.openTime > last.openTime) {
    arr.push(kline);
  } else if (kline.openTime === last.openTime) {
    arr[arr.length - 1] = kline;
  }
}

function trimOlderThan(arr, msCutoff) {
  while (arr.length > 0 && arr[0].openTime < msCutoff) arr.shift();
}

function sliceLastMinutes(arr, minutes) {
  const needMs = minutes * 60000;
  if (arr.length === 0) return [];
  const endMs = arr[arr.length - 1].openTime;
  const startMs = endMs - needMs + 60000;
  let i = arr.length - 1;
  while (i >= 0 && arr[i].openTime >= startMs) i--;
  return arr.slice(i + 1);
}

function sumVolumes(arr) {
  let s = 0;
  for (const k of arr) s += Number(k.volume || 0);
  return s;
}

function minLow(arr) {
  let m = Infinity;
  for (const k of arr) {
    const v = Number(k.low || 0);
    if (v < m) m = v;
  }
  return Number.isFinite(m) ? m : 0;
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function scorePrice(latest, min5m) {
  if (!(latest > 0) || !(min5m > 0)) return 0;
  const ratio = latest / min5m;
  if (ratio <= 1) return 0;
  if (ratio >= 1.02) return 0.5;
  return ((ratio - 1) / 0.02) * 0.5;
}

function scoreVolume(vol5m, avg5m) {
  if (!(avg5m > 0) || !(vol5m >= 0)) return 0;
  const ratio = vol5m / avg5m;
  if (ratio >= 2) return 0.5;
  return clamp01(ratio / 2) * 0.5;
}

function weightOf(sym) {
  if (sym === 'ETHUSDT') return 0.15;
  if (sym === 'SOLUSDT') return 0.05;
  return 0.01;
}

async function ensureInitialWindows(symbols) {
  logger.info({ symbols: symbols.length }, '开始回补近5小时窗口');
  for (const sym of symbols) {
    const arr = ensureWindowMap(sym);
    if (arr.length >= 280) continue;
    try {
      const ks = await fetchKlines1m(sym, 320);
      priceWindows.set(sym, ks);
      await sleep(50);
    } catch (e) {
      logger.warn({ sym, err: String(e) }, 'init window failed');
    }
  }
  logger.info('窗口回补完成');
}

async function refreshLastMinute(symbol) {
  try {
    const ks = await fetchKlines1m(symbol, 2);
    if (!Array.isArray(ks) || ks.length === 0) return;
    const arr = ensureWindowMap(symbol);
    pushOrReplaceLast(arr, ks[ks.length - 1]);
    const cutoff = (arr.length > 0 ? arr[arr.length - 1].openTime : Date.now()) - 5 * 60 * 60000;
    trimOlderThan(arr, cutoff);
  } catch (e) {
    logger.warn({ symbol, err: String(e) }, 'refresh last minute failed');
  }
}

function computeForSymbol(sym, avgMap) {
  const arr = ensureWindowMap(sym);
  if (arr.length === 0) return null;
  const latestK = arr[arr.length - 1];
  const last5 = sliceLastMinutes(arr, 5);
  const last300 = sliceLastMinutes(arr, 300);
  const min5 = minLow(last5);
  const vol5 = sumVolumes(last5);
  const preAvg = avgMap && Number(avgMap[sym]) > 0 ? Number(avgMap[sym]) : null;
  const avg5m = preAvg !== null ? preAvg : (sumVolumes(last300) / 60);
  const latestPrice = Number(latestK.close || 0);
  const price_score = scorePrice(latestPrice, min5);
  const vol_score = scoreVolume(vol5, avg5m);
  const symbol_score = price_score + vol_score;
  const weight = weightOf(sym);
  return {
    symbol: sym,
    price_score,
    vol_score,
    symbol_score,
    weight,
    latest_price: latestPrice,
    min_price_5m: min5,
    vol_5m: vol5,
    avg_vol_5m_5h: avg5m,
  };
}

async function computeMinute() {
  const tsMinute = floorToMinuteUTCms(new Date());
  logger.info({ ts: tsMinute }, '开始计算本分钟市场状态');
  const snap = getLatestUniverseSnapshotBefore(tsMinute);
  let symbols = [];
  if (snap && Array.isArray(snap.selected_51_130) && snap.selected_51_130.length > 0) {
    symbols = ['ETHUSDT', 'SOLUSDT', ...snap.selected_51_130];
    logger.debug({ total: symbols.length, source: 'snapshot' }, '使用快照的交易对列表');
  } else {
    const universe80 = await getOrBuildDailyUniverse(tsMinute);
    symbols = ['ETHUSDT', 'SOLUSDT', ...universe80];
    logger.debug({ total: symbols.length, source: 'on_demand' }, '使用当日计算的交易对列表');
  }
  const { ts_hour: avgTsHour, map: avgMap } = getAvgVolMapForLatestHourBefore(tsMinute);
  logger.debug({ avgTsHour }, '使用的每小时平均量快照');
  logger.debug({ total: symbols.length }, '本轮参与计算的交易对数量');
  await ensureInitialWindows(symbols);
  await batchSequential(symbols, async (s) => refreshLastMinute(s), 80);
  const rows = [];
  for (const s of symbols) {
    const r = computeForSymbol(s, avgMap);
    if (r) rows.push(r);
  }
  let total = 0;
  for (const r of rows) total += r.symbol_score * r.weight;
  const total_score = total * 100;
  const state = total_score > 60 ? 'aggressive' : 'conservative';
  logger.info({ ts: tsMinute, rows: rows.length, total_score: Number(total_score.toFixed(2)), state }, '汇总得分完成');
  for (const r of rows) {
    await upsertMarketStateSymbolMinute({
      ts_minute: tsMinute,
      symbol: r.symbol,
      price_score: r.price_score,
      vol_score: r.vol_score,
      symbol_score: r.symbol_score,
      weight: r.weight,
      latest_price: r.latest_price,
      min_price_5m: r.min_price_5m,
      vol_5m: r.vol_5m,
      avg_vol_5m_5h: r.avg_vol_5m_5h,
    });
  }
  await upsertMarketStateMinute({ ts_minute: tsMinute, total_score, state, details_version: 1 });
  logger.info({ tsMinute, total_score: Number(total_score.toFixed(2)), state, symbols: symbols.length }, '本分钟市场状态已写入');
}

function msUntilNextMinute() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  if (next <= now) next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next - now;
}

async function main() {
  while (true) {
    const wait = msUntilNextMinute();
    logger.debug({ waitMs: wait }, '距离下一分钟对齐的等待');
    await sleep(wait);
    try {
      await computeMinute();
    } catch (e) {
      logger.error({ err: String(e) }, 'compute minute failed');
    }
  }
}

main();
