// Rule3 策略：基于市值区间与5分钟成交额的档位匹配，绕过均量检查
// 配置示例：config.rule3ws.tierBypassStrategy = { tiers: [...], enableMarketState: true }
import logger from "../logger.js";
import { getMarketStateMinuteLast5Min, getMarketStateMinuteLast1Hour } from "../db.js";

const lastBucketSent = new Map(); // symbol -> last openTime

// 复用工具函数
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

function buildStrategyText(ctx, reasonLine, helpers, tierInfo) {
  const { symbol, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;
  const {
    formatNumber,
    formatCurrency,
    formatCurrencyCompact,
    buildBinanceFuturesUrl,
  } = helpers;

  const lines = [];
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  const prefixEmoji = '🔥🔥'; // tier bypass 策略前缀
  lines.push(`${prefixEmoji} ${link} ${trendEmoji || ''}`.trim());
  if (reasonLine) lines.push(`原因: ${reasonLine}`);
  lines.push(`成交量(USD): ${formatCurrencyCompact(sumTurnover)}`);
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
  // 附加档位匹配信息
  if (tierInfo && tierInfo.matched) {
    lines.push(`档位: 第${tierInfo.tierIndex + 1}档 (5m量=${formatCurrencyCompact(tierInfo.vol5m)})`);
  }
  return lines.join('\n');
}

export default async function rule3TierBypass(ctx, config, helpers) {
  const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;

  // 同一分钟桶去重
  const last = lastBucketSent.get(symbol);
  if (last === openTime) return;

  // 读取策略配置
  const stratCfg = (config && config.rule3ws && config.rule3ws.tierBypassStrategy) || {};
  
  // 检查黑名单
  const blacklist = Array.isArray(stratCfg.symbolBlacklist) ? stratCfg.symbolBlacklist : [];
  if (blacklist.length > 0 && blacklist.includes(symbol)) {
    logger.debug({ symbol }, 'tier_bypass策略：币对在黑名单中，跳过');
    return;
  }
  
  const tiers = Array.isArray(stratCfg.tiers) ? stratCfg.tiers : [];
  if (tiers.length === 0) {
    logger.debug({ symbol }, 'tier_bypass策略：未配置档位，跳过');
    return;
  }

  // 检查市值：若无法计算，使用默认市值（如果配置了）
  let effectiveMarketCap = marketCap;
  let usingDefaultMarketCap = false;
  if (!(Number.isFinite(marketCap) && marketCap > 0)) {
    const defaultMc = (typeof stratCfg.defaultMarketCapUsd === 'number' && stratCfg.defaultMarketCapUsd > 0) ? stratCfg.defaultMarketCapUsd : null;
    if (defaultMc) {
      effectiveMarketCap = defaultMc;
      usingDefaultMarketCap = true;
      logger.debug({ symbol, defaultMarketCapUsd: defaultMc }, 'tier_bypass策略：使用默认市值');
    } else {
      logger.debug({ symbol }, 'tier_bypass策略：缺少可用市值且未配置默认市值，跳过');
      return;
    }
  }

  // 检查窗口读取器
  if (!(helpers && typeof helpers.getWindow === 'function')) {
    logger.debug({ symbol }, 'tier_bypass策略：缺少窗口读取器，跳过');
    return;
  }

  // 计算5分钟成交额
  const win = helpers.getWindow(symbol) || [];
  const last5 = sliceLastMinutes(win, 5);
  const vol5m = sumVolumes(last5);

  // 档位匹配
  let matched = false;
  let matchedTierIndex = -1;
  let matchedTier = null;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] || {};
    const vCond = (typeof t.vol5mGteUsd === 'number' && t.vol5mGteUsd >= 0) ? (vol5m >= t.vol5mGteUsd) : false;
    let mcCond = false;
    const hasLt = (typeof t.marketCapLtUsd === 'number');
    const hasGte = (typeof t.marketCapGteUsd === 'number');
    if (hasLt && hasGte) {
      mcCond = (effectiveMarketCap >= t.marketCapGteUsd && effectiveMarketCap < t.marketCapLtUsd);
    } else if (hasLt) {
      mcCond = (effectiveMarketCap < t.marketCapLtUsd);
    } else if (hasGte) {
      mcCond = (effectiveMarketCap >= t.marketCapGteUsd);
    } else {
      mcCond = false;
    }
    if (vCond && mcCond) {
      matched = true;
      matchedTierIndex = i;
      matchedTier = t;
      // 先不输出日志，等通过冷却检查后再输出
      break;
    }
  }

  if (!matched) {
    logger.debug({ symbol, marketCap: effectiveMarketCap, usingDefault: usingDefaultMarketCap, vol5m, tiers: tiers.length }, 'tier_bypass策略：未匹配任何档位，跳过');
    return;
  }

  // 冷却检查
  const reason = `tier_bypass_${helpers.windowMinutes}m_${helpers.thresholdUsd}`;
  const local = helpers.shouldAlertLocal(symbol, reason, helpers.cooldownSec);
  if (!local.ok) {
    logger.debug({ symbol, marketCap: effectiveMarketCap, usingDefault: usingDefaultMarketCap, vol5m, tierIndex: matchedTierIndex, remainingSec: local.remainingSec }, 'tier_bypass策略：命中档位但本地冷却中，跳过');
    return;
  }
  const db = helpers.shouldAlert(symbol, reason, helpers.cooldownSec);
  if (!db.ok) {
    logger.debug({ symbol, marketCap: effectiveMarketCap, usingDefault: usingDefaultMarketCap, vol5m, tierIndex: matchedTierIndex, remainingSec: db.remainingSec }, 'tier_bypass策略：命中档位但数据库冷却中，跳过');
    return;
  }

  // 通过所有检查，输出命中档位日志
  logger.info({ symbol, marketCap: effectiveMarketCap, usingDefault: usingDefaultMarketCap, vol5m, tierIndex: matchedTierIndex, tier: matchedTier }, 'tier_bypass策略：命中档位并通过冷却检查，准备发送告警');

  // 标记已发送
  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);
  lastBucketSent.set(symbol, openTime);

  // 构建原因文案
  const mcLabel = usingDefaultMarketCap ? `市值${helpers.formatCurrencyCompact(effectiveMarketCap)}(默认)` : `市值${helpers.formatCurrencyCompact(effectiveMarketCap)}`;
  const reasonLine = `${mcLabel}且5m成交额${helpers.formatCurrencyCompact(vol5m)}，命中第${matchedTierIndex + 1}档`;
  const ratio = (typeof effectiveMarketCap === 'number' && effectiveMarketCap > 0) ? (sumTurnover / effectiveMarketCap) : undefined;

  // 从数据库查询最近5分钟的市场状态均值（由 market_state_cron.js 定时计算）
  let marketStateRes = null;
  let marketState1h = null;
  if (stratCfg.enableMarketState !== false) {
    try {
      const avgState = getMarketStateMinuteLast5Min();
      if (avgState) {
        marketStateRes = {
          price_score: avgState.price_score,
          volume_score: avgState.volume_score,
          state: avgState.state,
          state_text: avgState.state,
          sample_count: avgState.count,
        };
        logger.debug({ 
          symbol, 
          price_score: avgState.price_score.toFixed(2), 
          volume_score: avgState.volume_score.toFixed(2),
          sample_count: avgState.count 
        }, 'tier_bypass策略：查询到5分钟市场状态均值');
      }
      
      // 查询1小时均值
      const avgState1h = getMarketStateMinuteLast1Hour();
      if (avgState1h) {
        marketState1h = {
          price_score_1h: avgState1h.price_score,
          sample_count_1h: avgState1h.count,
        };
        logger.debug({ 
          symbol, 
          price_score_1h: avgState1h.price_score.toFixed(2),
          sample_count_1h: avgState1h.count 
        }, 'tier_bypass策略：查询到1小时市场状态均值');
      }
    } catch (e) {
      logger.warn({ err: String(e) }, 'tier_bypass策略：查询市场状态失败，忽略');
    }
  }

  // 计算速度与价格变动（基于5m窗口）
  let halfBars = undefined;
  let priceChangePct = undefined;
  const volume_threshold_ratio = (typeof stratCfg.volumeThresholdRatio === 'number' && stratCfg.volumeThresholdRatio > 0) ? stratCfg.volumeThresholdRatio : 0.7;
  try {
    if (Array.isArray(win) && win.length > 0) {
      const volume_threshold = volume_threshold_ratio * vol5m;
      let acc = 0;
      let count = 0;
      for (let i = win.length - 1; i >= 0; i--) {
        const v = Number(win[i] && win[i].volume || 0);
        acc += v;
        count++;
        if (acc >= volume_threshold) {
          halfBars = count;
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
  } catch {}

  // 构建文本（使用 effectiveMarketCap 覆盖 ctx.marketCap）
  const ctxWithEffectiveMc = { ...ctx, marketCap: effectiveMarketCap };
  const tierInfo = { matched: true, tierIndex: matchedTierIndex, vol5m, usingDefaultMarketCap };
  let text = buildStrategyText(ctxWithEffectiveMc, reasonLine, helpers, tierInfo);
  try {
    const extra = [];
    if (typeof halfBars === 'number') extra.push(`速度: 最近${halfBars}根1m达到阈值${volume_threshold_ratio}`);
    if (typeof priceChangePct === 'number') extra.push(`价格变动: ${helpers.formatNumber(priceChangePct, 3)}`);
    if (extra.length) text = `${text}\n${extra.join('\n')}`;
  } catch {}

  // 发送告警
  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap: effectiveMarketCap,
    ratio,
    type: "2",
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct,
    market_price_score: (marketStateRes && typeof marketStateRes.price_score === 'number') ? Number(marketStateRes.price_score.toFixed(2)) : undefined,
    market_volume_score: (marketStateRes && typeof marketStateRes.volume_score === 'number') ? Number(marketStateRes.volume_score.toFixed(2)) : undefined,
    market_state_text: marketStateRes ? marketStateRes.state_text : undefined,
    market_state: marketStateRes ? marketStateRes.state : undefined,
    market_price_score_1h: (marketState1h && typeof marketState1h.price_score_1h === 'number') ? Number(marketState1h.price_score_1h.toFixed(2)) : undefined,
    half_bars_to_half_threshold: typeof halfBars === 'number' ? halfBars : undefined,
    price_change_pct_from_earliest_open: (typeof priceChangePct === 'number') ? Number(priceChangePct.toFixed(3)) : undefined,
    tier_index: matchedTierIndex,
    vol_5m: vol5m,
    using_default_market_cap: usingDefaultMarketCap
  }, { strategy: 'tier_bypass', text });
}
