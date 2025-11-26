// 默认 Rule3 WS 策略（插件化）
import logger from "../logger.js";
import { getMarketStateMinuteLast5Min, getMarketStateMinuteLast1Hour, getLatestMarketVolumeScore } from "../db.js";
import { computeWeightedMarketStateMA } from "../market_state_aggregator.js";
import * as helpers from "../alerting/index.js";
import { klineCache } from "../kline_redis_cache.js";
// 行为与内置版本一致：当聚合器计算的滚动成交额 sum >= 阈值 thresholdUsd 时：
// - 若启用市值过滤(marketCapMaxUsd > 0)，要求市值在 (0, marketCapMaxUsd)
// - 同一分钟桶去重
// - 冷却检查（本地 + 数据库）
// - 通过 helpers.notify() 发送格式化告警
// 仅在聚合器已判定 sumTurnover >= 阈值时被调用。
// 签名：(ctx, config, helpers)

const lastBucketSent = new Map(); // symbol -> last openTime

function buildStrategyText(ctx, reasonLine, helpers) {
  const { symbol, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice, dynamicThreshold, market_volume_score_2, volume_score_ratio } = ctx;
  const {
    formatNumber,
    formatCurrency,
    formatCurrencyCompact,
    buildBinanceFuturesUrl,
  } = helpers;

  const lines = [];
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  const prefixEmoji = '‼️‼️'; // rule3 默认策略前缀
  lines.push(`${prefixEmoji} ${link} ${trendEmoji || ''}`.trim());
  if (reasonLine) lines.push(`原因: ${reasonLine}`);
  
  // 显示成交量信息，包括动态阈值
  if (typeof dynamicThreshold === 'number' && typeof market_volume_score_2 === 'number' && typeof volume_score_ratio === 'number') {
    lines.push(`成交量: ${formatCurrencyCompact(sumTurnover)} (阈值: ${formatCurrencyCompact(dynamicThreshold)}, VS: ${market_volume_score_2.toFixed(2)}, 比率: ${volume_score_ratio.toFixed(2)})`);
  } else {
    lines.push(`成交量(USD): ${formatCurrencyCompact(sumTurnover)}`);
  }
  
  if (Number.isFinite(marketCap)) lines.push(`市值: ${formatCurrencyCompact(marketCap)}`);
  if (Number.isFinite(marketCap) && marketCap > 0) {
    const ratio = sumTurnover / marketCap;
    const digits = ratio < 0.01 ? 4 : 2;
    lines.push(`倍数: ${formatNumber(ratio, digits)}`);
  }
  const prev = Number.isFinite(prevForDisplay) ? prevForDisplay : undefined;
  const close = Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined);
  if (typeof prev === 'number' && typeof close === 'number') {
    const pctText = (typeof deltaPct === 'number' && Number.isFinite(deltaPct)) ? ` (${deltaPct >= 0 ? '+' : ''}${formatNumber(deltaPct * 100)}%)` : '';
    lines.push(`价格: ${formatCurrency(prev)} → ${formatCurrency(close)}${pctText} ${trendEmoji || ''}`.trim());
  }
  return lines.join('\n');
}

// 计算逻辑已移至 market_state_calculator.js
// 此处保留辅助函数供其他逻辑使用

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

function minLow(arr) {
  let m = Infinity;
  for (const k of arr) {
    const v = Number(k.low || 0);
    if (v < m) m = v;
  }
  return Number.isFinite(m) ? m : 0;
}

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
  const r = ratio / 2;
  const clamped = Math.max(0, Math.min(1, r));
  return clamped * 0.5;
}

function weightOf(sym) {
  if (sym === 'ETHUSDT') return 0.15;
  if (sym === 'SOLUSDT') return 0.05;
  return 0.01;
}

export async function computeMarketStateRealtime(tsMs, readers, options = {}) {
  const hourKey = floorToHourUTCms(new Date(tsMs));
  const periodKey = floorTo12hUTCms(new Date(tsMs));

  if (!cachedUniverse.symbols || cachedUniverse.ts_period !== periodKey) {
    const snap = getLatestUniverseSnapshotBefore(tsMs);
    const list = (snap && Array.isArray(snap.selected_51_130)) ? snap.selected_51_130 : [];
    cachedUniverse = { ts_period: periodKey, symbols: ['ETHUSDT', 'SOLUSDT', ...list] };
  }

  if (!cachedAvg.map || cachedAvg.ts_hour !== hourKey) {
    const { ts_hour, map } = getAvgVolMapForLatestHourBefore(tsMs);
    cachedAvg = { ts_hour: ts_hour || hourKey, map: map || {} };
  }

  const symbols = cachedUniverse.symbols || [];
  const avgMap = cachedAvg.map || {};
  const rows = [];
  for (const sym of symbols) {
    const win = readers && typeof readers.getWindow === 'function' ? readers.getWindow(sym) : null;
    if (!Array.isArray(win) || win.length === 0) continue;
    const last5 = sliceLastMinutes(win, 5);
    if (last5.length === 0) continue;
    const min5 = minLow(last5);
    const vol5 = sumVolumes(last5);
    const latest = Number(win[win.length - 1].close || 0);
    const preAvg = Number(avgMap[sym] || 0);
    const avg5m = preAvg > 0 ? preAvg : 0;
    const price_score = scorePrice(latest, min5);
    const vol_score = scoreVolume(vol5, avg5m);
    const symbol_score = price_score + vol_score;
    const weight = weightOf(sym);
    rows.push({
      symbol: sym,
      price_score,
      vol_score,
      symbol_score,
      weight,
      latest_price: latest,
      min_price_5m: min5,
      vol_5m: vol5,
      avg_vol_5m_5h: avg5m,
    });
  }

  let total = 0;
  for (const r of rows) total += r.symbol_score * r.weight;
  const total_score = total * 100;
  const threshold = (typeof options.aggressiveThreshold === 'number' && Number.isFinite(options.aggressiveThreshold)) ? options.aggressiveThreshold : 60;
  const state_text = total_score > threshold ? 'aggressive' : 'conservative';
  const state = total_score > threshold ? 1 : 0;
  return { ts: tsMs, total_score, state, state_text, rows };
}


export default async function rule3Default(ctx, config, helpers) {
  const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice, market_volume_score_2, volume_score_ratio, dynamicThreshold } = ctx;

  // 同一分钟桶去重
  const last = lastBucketSent.get(symbol);
  if (last === openTime) return;

  // 市值过滤
  if (helpers.marketCapMaxUsd > 0) {
    if (!Number.isFinite(marketCap) || !(marketCap > 0 && marketCap < helpers.marketCapMaxUsd)) return;
  }

  const reason = `ws_rule3_${helpers.windowMinutes}m_${helpers.thresholdUsd}`;

  // 冷却检查
  const local = helpers.shouldAlertLocal(symbol, reason, helpers.cooldownSec);
  if (!local.ok) return;
  const db = helpers.shouldAlert(symbol, reason, helpers.cooldownSec);
  if (!db.ok) return;

  // 标记已发送
  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);
  lastBucketSent.set(symbol, openTime);

  // 注释：档位匹配逻辑已独立到 rule3_tier_bypass.js 策略
  // 如需使用档位绕过均量检查，请配置 wsStrategies: ["./strategies/rule3_tier_bypass.js"]
  // 
  // // 按档位配置，基于市值与5m成交额，决定是否绕过均量检查
  // let bypassAvg = false;
  // try {
  //   const ruleCfg = (config && config.rule3ws) || {};
  //   const tiers = Array.isArray(ruleCfg.bypassAvgVolumeTiers) ? ruleCfg.bypassAvgVolumeTiers : [];
  //   if (tiers.length > 0) {
  //     if (!(Number.isFinite(marketCap) && marketCap > 0)) {
  //       logger.debug({ symbol }, '均量绕过检查：缺少可用市值，跳过档位匹配');
  //     } else if (!(helpers && typeof helpers.getWindow === 'function')) {
  //       logger.debug({ symbol }, '均量绕过检查：缺少窗口读取器，跳过档位匹配');
  //     } else {
  //       const win = helpers.getWindow(symbol) || [];
  //       const last5 = sliceLastMinutes(win, 5);
  //       const vol5m = sumVolumes(last5);
  //       for (let i = 0; i < tiers.length; i++) {
  //         const t = tiers[i] || {};
  //         const vCond = (typeof t.vol5mGteUsd === 'number' && t.vol5mGteUsd >= 0) ? (vol5m >= t.vol5mGteUsd) : false;
  //         let mcCond = false;
  //         const hasLt = (typeof t.marketCapLtUsd === 'number');
  //         const hasGte = (typeof t.marketCapGteUsd === 'number');
  //         if (hasLt && hasGte) {
  //           mcCond = (marketCap >= t.marketCapGteUsd && marketCap < t.marketCapLtUsd);
  //         } else if (hasLt) {
  //           mcCond = (marketCap < t.marketCapLtUsd);
  //         } else if (hasGte) {
  //           mcCond = (marketCap >= t.marketCapGteUsd);
  //         } else {
  //           mcCond = false; // no bounds specified => do not match by market cap
  //         }
  //         if (vCond && mcCond) {
  //           bypassAvg = true;
  //           logger.info({ symbol, marketCap, vol5m, tierIndex: i, tier: t }, '均量检查：满足档位，绕过均量检查');
  //           break;
  //         }
  //       }
  //       if (!bypassAvg) {
  //         logger.debug({ symbol, marketCap, vol5m, tiers: tiers.length }, '均量检查：未匹配任何档位，不绕过');
  //       }
  //     }
  //   }
  // } catch (e) {
  //   logger.warn({ symbol, err: e.message }, '均量绕过检查：异常，按未绕过处理');
  // }

  // 均量检查（可选）：
  // 从 Redis 获取最近 limit 根 1m K 线；使用前 (limit - windowMinutes) 根，按 windowMinutes 为一组不重叠分组，
  // 计算这些分组的 5m（或 W 分钟）成交额均值 baseline，要求当前窗口 sumTurnover >= multiplier * baseline。
  // 示例：limit=100, windowMinutes=5，则均量 = sum(vol(100-5)) / ((100-5)/5)。
  try {
    const ruleCfg = (config && config.rule3ws) || {};
    const enabled = !!ruleCfg.enableAvgVolumeCheck;
    const multiplier = (typeof ruleCfg.avgVolumeMultiplier === 'number' && ruleCfg.avgVolumeMultiplier > 0) ? ruleCfg.avgVolumeMultiplier : 2;
    const W = Math.max(1, Math.floor(helpers.windowMinutes));
    const limit = (typeof ruleCfg.avgVolumeKlinesLimit === 'number' && ruleCfg.avgVolumeKlinesLimit > W)
      ? Math.min(1500, Math.floor(ruleCfg.avgVolumeKlinesLimit))
      : 100; // 默认 100
    if (enabled) {
      // 从 Redis 获取最近 limit 根 K 线
      const now = Date.now();
      const toTs = Math.floor(now / 60000) * 60000 - 60000; // 上一个已完成的分钟
      const fromTs = toTs - (limit - 1) * 60000; // 往前推 limit-1 分钟
      
      const klines = await klineCache.getKlines(symbol, fromTs, toTs);
      
      if (Array.isArray(klines) && klines.length >= limit - 5) { // 允许少量缺失（最多 5 根）
        // 按时间戳排序（升序）
        klines.sort((a, b) => a.t - b.t);
        
        // 使用前 (length - W) 根，避免与当前窗口重叠
        const usable = klines.slice(0, Math.max(0, klines.length - W));
        const blocks = Math.floor(usable.length / W);
        
        if (blocks > 0) {
          let total = 0;
          for (let b = 0; b < blocks; b++) {
            let sum = 0;
            for (let j = 0; j < W; j++) {
              const k = usable[b * W + j];
              // k.q 为该 1m 的报价资产成交量（USDT）
              const q = parseFloat(k && k.q);
              if (Number.isFinite(q)) sum += q;
            }
            total += sum;
          }
          const avgW = total / blocks;
          if (!(sumTurnover >= multiplier * avgW)) {
            // 未达到均量倍数阈值，跳过告警
            logger.debug({ 
              symbol,
              source: 'redis',
              klines: klines.length,
              usable: usable.length, 
              blocks,
              W,
              avgW: avgW.toFixed(2),
              sumTurnover: sumTurnover.toFixed(2),
              multiplier
            }, `均量检查：${symbol}, ${helpers.windowMinutes}m成交量${sumTurnover.toFixed(2)} 没有超过均值 ${avgW.toFixed(2)} 的 ${multiplier} 倍，不发送`);
            return;
          }
          logger.info({ 
            symbol,
            source: 'redis',
            klines: klines.length,
            usable: usable.length, 
            blocks,
            W,
            avgW: avgW.toFixed(2),
            sumTurnover: sumTurnover.toFixed(2),
            multiplier
          }, `均量检查：${symbol}, ${helpers.windowMinutes}m成交量${sumTurnover.toFixed(2)} 超过均值 ${avgW.toFixed(2)} 的 ${multiplier} 倍，发送告警`);
        } else {
          logger.warn({ symbol, source: 'redis', usable: usable.length, W }, '均量检查：可用数据不足以分组，不发送');
          return;
        }
      } else {
        logger.warn({ 
          symbol, 
          source: 'redis',
          got: Array.isArray(klines) ? klines.length : 0, 
          need: limit,
          fromTs,
          toTs
        }, '均量检查：Redis K 线数量不足，不发送');
        return;
      }
    }
    // 注释：bypassAvg 逻辑已移除，此处保底日志已无意义
    // if (!enabled && !bypassAvg && !!ruleCfg.enableAvgVolumeCheck) {
    //   // enable=true 但被其他原因短路（理论上不会到这里）；保底日志
    //   logger.debug({ symbol }, '均量检查：被禁用或未启用');
    // }
  } catch (e) {
    logger.error({ err: e.message }, '均量检查：发生异常，不发送');
    return
  }

  // 构建原因文案与倍数
  const reasonLine = (helpers.marketCapMaxUsd > 0)
    ? `市值低于$${(helpers.marketCapMaxUsd/1_000_000).toFixed(2)}M且${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`
    : `${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`;
  const ratio = (typeof marketCap === 'number' && marketCap > 0) ? (sumTurnover / marketCap) : undefined;

  // 计算市值<5亿所有币种的MA5和MA60（相同权重）
  let marketStateRes = null;
  let marketState1h = null;
  try {
    // 构建实时价格 Map
    const priceMap = new Map();
    if (helpers && typeof helpers.getAllPrices === 'function') {
      const prices = helpers.getAllPrices();
      for (const [sym, price] of Object.entries(prices)) {
        priceMap.set(sym, price);
      }
    }
    
    const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);
    
    marketStateRes = {
      price_score: marketStateMA.ma5.price_score,
      volume_score: marketStateMA.ma5.volume_score,
      state: null,
      state_text: null,
      sample_count: marketStateMA.ma5.symbols_count,
    };
    
    marketState1h = {
      price_score_1h: marketStateMA.ma60.price_score,
      sample_count_1h: marketStateMA.ma60.symbols_count,
    };
    
    logger.debug({ 
      symbol, 
      price_score_ma5: marketStateMA.ma5.price_score.toFixed(2), 
      volume_score_ma5: marketStateMA.ma5.volume_score.toFixed(2),
      symbols_count_ma5: marketStateMA.ma5.symbols_count,
      price_score_ma60: marketStateMA.ma60.price_score.toFixed(2),
      symbols_count_ma60: marketStateMA.ma60.symbols_count
    }, '计算市场状态MA完成');
  } catch (e) {
    logger.warn({ err: String(e), stack: e.stack }, '计算市场状态MA失败，忽略');
  }

  let halfBars = undefined;
  let halfMs = undefined;
  let priceChangePct = undefined;
  let volume_threshold_ratio = 0.7;
  try {
    if (helpers && typeof helpers.getWindow === 'function') {
      const win = helpers.getWindow(symbol) || [];
      if (Array.isArray(win) && win.length > 0) {
        const last5 = sliceLastMinutes(win, 5);
        const vol5m = sumVolumes(last5);
        const volume_threshold = volume_threshold_ratio * vol5m;
        let acc = 0;
        let count = 0;
        for (let i = win.length - 1; i >= 0; i--) {
          const v = Number(win[i] && win[i].volume || 0);
          acc += v;
          count++;
          if (acc >= volume_threshold) {
            halfBars = count;
            halfMs = count * 60000;
            const earliest = win[i];
            const latest = win[win.length - 1];
            const o = Number(earliest && earliest.open);
            const c = Number(latest && latest.close);
            if (Number.isFinite(o) && o > 0 && Number.isFinite(c)) {
              priceChangePct = (c - o) / o;
            }
            break;
          }
        }
      }
    }
  } catch {}

  // 使用从 context 传入的 market_volume_score_2（已在 ws_rule3_monitor.js 中获取）
  const marketVolumeScore2 = (typeof ctx.market_volume_score_2 === 'number') ? Number(ctx.market_volume_score_2.toFixed(4)) : null;

  let text = buildStrategyText(ctx, reasonLine, helpers);
  try {
    const extra = [];
    if (typeof halfBars === 'number') extra.push(`速度: 最近${halfBars}根1m达到阈值${volume_threshold_ratio}`);
    if (typeof priceChangePct === 'number') extra.push(`价格变动: ${helpers.formatNumber(priceChangePct, 3)}`);
    if (extra.length) text = `${text}\n${extra.join('\n')}`;
  } catch {}

  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio,
    type: "1",
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct,
    market_price_score: (marketStateRes && typeof marketStateRes.price_score === 'number') ? Number(marketStateRes.price_score.toFixed(2)) : undefined,
    market_volume_score: (marketStateRes && typeof marketStateRes.volume_score === 'number') ? Number(marketStateRes.volume_score.toFixed(2)) : undefined,
    market_volume_score_2: marketVolumeScore2,
    market_state_text: marketStateRes ? marketStateRes.state_text : undefined,
    market_state: marketStateRes ? marketStateRes.state : undefined,
    market_price_score_1h: (marketState1h && typeof marketState1h.price_score_1h === 'number') ? Number(marketState1h.price_score_1h.toFixed(2)) : undefined,
    half_bars_to_half_threshold: typeof halfBars === 'number' ? halfBars : undefined,
    price_change_pct_from_earliest_open: (typeof priceChangePct === 'number') ? Number(priceChangePct.toFixed(3)) : undefined,
    // 动态阈值相关字段
    volume_score_ratio: (typeof volume_score_ratio === 'number') ? Number(volume_score_ratio.toFixed(2)) : undefined,
    dynamic_threshold: (typeof dynamicThreshold === 'number') ? dynamicThreshold : undefined,
  }, { strategy: `${helpers.windowMinutes}m_turnover`, text });
}
