// 市场状态计算模块（独立于策略）
import logger from "./logger.js";
import { getLatestUniverseSnapshotBefore, getAvgVolMapForLatestHourBefore, getAllSymbolsWithCirculatingSupply } from "./db.js";

function floorToHourUTCms(d) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t.getTime();
}

function floorTo12hUTCms(d) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  const h = t.getUTCHours();
  const h12 = Math.floor(h / 12) * 12;
  t.setUTCHours(h12);
  return t.getTime();
}

function sliceLastMinutes(arr, minutes) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const needMs = minutes * 60000;
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

function firstOpen(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const v = Number(arr[0].open || 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * 价格得分：使用 sigmoid 归一化到 -1 ~ 1
 * @param {number} latest - 最新价格
 * @param {number} open5m - 5分钟开盘价
 * @param {number} k - sigmoid 参数，默认60（±3%变化对应±0.86分）
 * @returns {number} 得分范围 -1 ~ 1
 */
function scorePrice(latest, open5m, k = 100) {
  if (!(latest > 0) || !(open5m > 0)) return 0;
  const x = (latest - open5m) / open5m;
  // sigmoid: 2/(1+e^(-kx)) - 1, 范围 -1 ~ 1
  const score = 2 / (1 + Math.exp(-k * x)) - 1;
  return score;
}

/**
 * 成交量得分：ReLU方式，3倍时得满分
 * @param {number} vol5m - 5分钟成交量
 * @param {number} avg5m - 5分钟平均成交量
 * @returns {number} 得分范围 0 ~ 1
 */
function scoreVolume(vol5m, avg5m) {
  if (!(avg5m > 0) || !(vol5m >= 0)) return 0;
  const ratio = vol5m / avg5m;
  // 3倍时得满分
  return Math.min(ratio / 3, 1.0);
}

/**
 * 获取币种权重
 */
function weightOf(sym) {
  if (sym === 'ETHUSDT') return 0.15;
  if (sym === 'SOLUSDT') return 0.05;
  return 0.01;
}

// 缓存
let cachedUniverse = { ts_hour: null, symbols: null, supplyMap: null };
let cachedAvg = { ts_hour: null, map: null };

/**
 * 实时计算市场状态
 * @param {number} tsMs - 时间戳（毫秒）
 * @param {object} readers - 数据读取器，需提供 getWindow(symbol) 方法和 getPrice(symbol) 方法
 * @param {object} options - 可选配置 { maxMarketCapUsd: 500000000 }
 * @returns {object} { ts, price_score, volume_score, state, state_text, rows }
 */
export async function computeMarketStateRealtime(tsMs, readers, options = {}) {
  const hourKey = floorToHourUTCms(new Date(tsMs));
  const maxMarketCapUsd = options.maxMarketCapUsd || 500_000_000; // 默认5亿美元

  // 更新 universe 缓存（每小时更新一次）
  if (!cachedUniverse.symbols || cachedUniverse.ts_hour !== hourKey) {
    // 获取所有有流通供应量的币种
    const supplyRows = getAllSymbolsWithCirculatingSupply();
    const supplyMap = new Map();
    for (const row of supplyRows) {
      supplyMap.set(row.symbol, row.circulating_supply);
    }
    cachedUniverse = { ts_hour: hourKey, symbols: null, supplyMap };
    // logger.info({ count: supplyRows.length }, '更新币种供应量缓存');
  }

  // 更新均量缓存
  if (!cachedAvg.map || cachedAvg.ts_hour !== hourKey) {
    const { ts_hour, map } = getAvgVolMapForLatestHourBefore(tsMs);
    cachedAvg = { ts_hour: ts_hour || hourKey, map: map || {} };
  }

  const avgMap = cachedAvg.map || {};
  const supplyMap = cachedUniverse.supplyMap || new Map();
  
  // 第一步：计算所有币种的实时市值并筛选
  const symbolsWithMarketCap = [];
  for (const [baseSymbol, circulating] of supplyMap.entries()) {
    const symbol = `${baseSymbol}USDT`;
    
    // 获取实时价格
    let price = 0;
    if (readers && typeof readers.getPrice === 'function') {
      price = readers.getPrice(symbol) || 0;
    }
    
    if (price > 0 && circulating > 0) {
      const marketCap = price * circulating;
      if (marketCap > 0 && marketCap < maxMarketCapUsd) {
        symbolsWithMarketCap.push({ symbol, marketCap, circulating, price });
      }
    }
  }
  
  // 按市值降序排序
  symbolsWithMarketCap.sort((a, b) => b.marketCap - a.marketCap);
  
  // 限制最多500个币种
  const maxSymbols = options.maxSymbols || 500;
  const selectedSymbols = symbolsWithMarketCap.slice(0, maxSymbols);
  
  logger.debug({ 
    total: symbolsWithMarketCap.length, 
    selected: selectedSymbols.length,
    maxCap: maxMarketCapUsd 
  }, '筛选市值<5亿的币种');
  
  // 第二步：计算每个币种的得分
  const rows = [];

  // 计算总市值（用于权重计算）
  let totalMarketCap = 0;
  for (const item of selectedSymbols) {
    totalMarketCap += item.marketCap;
  }
  
  // 计算每个币种的得分
  for (const item of selectedSymbols) {
    const sym = item.symbol;
    const win = readers && typeof readers.getWindow === 'function' ? await readers.getWindow(sym) : null;
    if (!Array.isArray(win) || win.length === 0) continue;
    
    const last5 = sliceLastMinutes(win, 5);
    if (last5.length === 0) continue;
    
    const open5 = firstOpen(last5);
    const vol5 = sumVolumes(last5);
    const latest = Number(win[win.length - 1].close || 0);
    const preAvg = Number(avgMap[sym] || 0);
    const avg5m = preAvg > 0 ? preAvg : 0;
    
    const price_score = scorePrice(latest, open5);
    const vol_score = scoreVolume(vol5, avg5m);
    const symbol_score = price_score + vol_score;
    
    // 使用市值加权
    const weight = totalMarketCap > 0 ? item.marketCap / totalMarketCap : 0;
    
    rows.push({
      symbol: sym,
      price_score,
      vol_score,
      symbol_score,
      weight,
      latest_price: latest,
      open_price_5m: open5,
      vol_5m: vol5,
      avg_vol_5m_5h: avg5m,
    });
  }

  // 计算总分
  let total_price = 0;
  let total_volume = 0;
  for (const r of rows) {
    total_price += r.price_score * r.weight;
    total_volume += r.vol_score * r.weight;
  }
  
  const price_score = total_price * 100;  // -100 ~ 100
  const volume_score = total_volume * 100; // 0 ~ 100

  // State 判断逻辑暂时注释
  // const threshold = (typeof options.aggressiveThreshold === 'number' && Number.isFinite(options.aggressiveThreshold)) ? options.aggressiveThreshold : 60;
  // const combined_score = price_score + volume_score;
  // const state_text = combined_score > threshold ? 'aggressive' : 'conservative';
  // const state = combined_score > threshold ? 1 : 0;
  
  const state_text = null;
  const state = null;

  return { 
    ts: tsMs, 
    price_score, 
    volume_score, 
    state, 
    state_text, 
    rows 
  };
}

/**
 * 清除缓存（用于测试或强制刷新）
 */
export function clearCache() {
  cachedUniverse = { ts_period: null, symbols: null };
  cachedAvg = { ts_hour: null, map: null };
}
