// 市场状态聚合计算模块
// 用于计算市值<5亿的所有币种的MA5和MA60，并按相同权重合并
import logger from './logger.js';
import { 
  getAllSymbolsWithCirculatingSupply, 
  getBatchSymbolStateMinutesHistory,
  getLatestMarketStateSymbols 
} from './db.js';

// 缓存
let cachedResult = null;
let lastCalcTime = 0;
const CACHE_DURATION_MS = 1000; // 1秒缓存

/**
 * 计算单个币种的 MA
 * @param {Array} stateHistory - 币种的历史state数据
 * @returns {Object} { price_score_ma, vol_score_ma, sample_count }
 */
function computeSymbolMA(stateHistory) {
  if (!Array.isArray(stateHistory) || stateHistory.length === 0) {
    return { price_score_ma: 0, vol_score_ma: 0, sample_count: 0 };
  }
  
  let sumPrice = 0;
  let sumVol = 0;
  let count = 0;
  
  for (const row of stateHistory) {
    if (typeof row.price_score === 'number' && Number.isFinite(row.price_score)) {
      sumPrice += row.price_score;
    }
    if (typeof row.vol_score === 'number' && Number.isFinite(row.vol_score)) {
      sumVol += row.vol_score;
    }
    count++;
  }
  
  if (count === 0) {
    return { price_score_ma: 0, vol_score_ma: 0, sample_count: 0 };
  }
  
  return {
    price_score_ma: sumPrice / count,
    vol_score_ma: sumVol / count,
    sample_count: count
  };
}

/**
 * 计算市值加权的总体市场状态（相同权重版本）
 * @param {number} maxMarketCapUsd - 最大市值（默认5亿）
 * @param {Map<string, number>} priceMap - 实时价格 Map (symbol -> price)
 * @returns {Object} {
 *   ma5: { price_score, volume_score, symbols_count },
 *   ma60: { price_score, volume_score, symbols_count }
 * }
 */
export async function computeWeightedMarketStateMA(maxMarketCapUsd = 500_000_000, priceMap = new Map()) {
  const now = Date.now();
  
  // 使用缓存
  if (cachedResult && (now - lastCalcTime) < CACHE_DURATION_MS) {
    logger.debug('使用缓存的市场状态MA结果');
    return cachedResult;
  }
  
  try {
    // 1. 获取最近一次市场状态计算中的所有币种（这些币种已经是市值<5亿的）
    const symbols = getLatestMarketStateSymbols();
    
    if (symbols.length === 0) {
      logger.warn('未找到任何币种的市场状态数据');
      return {
        ma5: { price_score: 0, volume_score: 0, symbols_count: 0 },
        ma60: { price_score: 0, volume_score: 0, symbols_count: 0 }
      };
    }
    
    logger.debug({ symbols_count: symbols.length }, '开始计算市场状态MA');
    
    // 2. 批量获取所有币种的MA5和MA60数据
    const stateHistory5 = getBatchSymbolStateMinutesHistory(symbols, 5);
    const stateHistory60 = getBatchSymbolStateMinutesHistory(symbols, 60);
    
    // 3. 计算每个币种的MA5和MA60
    const symbolMA5List = [];
    const symbolMA60List = [];
    
    for (const symbol of symbols) {
      const history5 = stateHistory5.get(symbol) || [];
      const history60 = stateHistory60.get(symbol) || [];
      
      const ma5 = computeSymbolMA(history5);
      const ma60 = computeSymbolMA(history60);
      
      if (ma5.sample_count > 0) {
        symbolMA5List.push(ma5);
      }
      
      if (ma60.sample_count > 0) {
        symbolMA60List.push(ma60);
      }
    }
    
    // 4. 相同权重合并（简单平均）
    let totalPriceScore5 = 0;
    let totalVolScore5 = 0;
    let count5 = 0;
    
    for (const ma of symbolMA5List) {
      totalPriceScore5 += ma.price_score_ma;
      totalVolScore5 += ma.vol_score_ma;
      count5++;
    }
    
    let totalPriceScore60 = 0;
    let totalVolScore60 = 0;
    let count60 = 0;
    
    for (const ma of symbolMA60List) {
      totalPriceScore60 += ma.price_score_ma;
      totalVolScore60 += ma.vol_score_ma;
      count60++;
    }
    
    const result = {
      ma5: {
        price_score: count5 > 0 ? (totalPriceScore5 / count5) * 100 : 0,  // 乘以100，范围 -100 ~ 100
        volume_score: count5 > 0 ? (totalVolScore5 / count5) * 100 : 0,   // 乘以100，范围 0 ~ 100
        symbols_count: count5
      },
      ma60: {
        price_score: count60 > 0 ? (totalPriceScore60 / count60) * 100 : 0,  // 乘以100，范围 -100 ~ 100
        volume_score: count60 > 0 ? (totalVolScore60 / count60) * 100 : 0,   // 乘以100，范围 0 ~ 100
        symbols_count: count60
      }
    };
    
    // 更新缓存
    cachedResult = result;
    lastCalcTime = now;
    
    logger.debug({ 
      ma5_price: result.ma5.price_score.toFixed(2),
      ma5_volume: result.ma5.volume_score.toFixed(2),
      ma5_count: result.ma5.symbols_count,
      ma60_price: result.ma60.price_score.toFixed(2),
      ma60_volume: result.ma60.volume_score.toFixed(2),
      ma60_count: result.ma60.symbols_count
    }, '市场状态MA计算完成');
    
    return result;
    
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, '计算市场状态MA失败');
    throw e;
  }
}

/**
 * 清除缓存（用于测试或强制重新计算）
 */
export function clearCache() {
  cachedResult = null;
  lastCalcTime = 0;
}
