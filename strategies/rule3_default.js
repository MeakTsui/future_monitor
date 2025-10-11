// 默认 Rule3 WS 策略（插件化）
import fetch from "node-fetch";
import logger from "../logger.js";
// 行为与内置版本一致：当聚合器计算的滚动成交额 sum >= 阈值 thresholdUsd 时：
// - 若启用市值过滤(marketCapMaxUsd > 0)，要求市值在 (0, marketCapMaxUsd)
// - 同一分钟桶去重
// - 冷却检查（本地 + 数据库）
// - 通过 helpers.notify() 发送格式化告警
// 仅在聚合器已判定 sumTurnover >= 阈值时被调用。
// 签名：(ctx, config, helpers)

const lastBucketSent = new Map(); // symbol -> last openTime

function buildStrategyText(ctx, reasonLine, helpers) {
  const { symbol, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;
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
  return lines.join('\n');
}

export default async function rule3Default(ctx, config, helpers) {
  const { symbol, openTime, sumTurnover, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji, closePrice } = ctx;

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

  // 均量检查（可选）：
  // 拉取最近 limit 根 1m K 线；使用前 (limit - windowMinutes) 根，按 windowMinutes 为一组不重叠分组，
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
      const base = (typeof ruleCfg.restBaseUrl === 'string' && ruleCfg.restBaseUrl) ? ruleCfg.restBaseUrl : 'https://fapi.binance.com';
      const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${limit}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length === limit) {
          // 使用前 (limit - W) 根，避免与当前窗口重叠
          const usable = data.slice(0, limit - W);
          const blocks = Math.floor(usable.length / W);
          if (blocks > 0) {
            let total = 0;
            for (let b = 0; b < blocks; b++) {
              let sum = 0;
              for (let j = 0; j < W; j++) {
                const k = usable[b * W + j];
                // k[7] 为该 1m 的报价资产成交量（USDT）
                const q = parseFloat(k && k[7]);
                if (Number.isFinite(q)) sum += q;
              }
              total += sum;
            }
            const avgW = total / blocks;
            if (!(sumTurnover >= multiplier * avgW)) {
              // 未达到均量倍数阈值，跳过告警
              logger.debug({ usable: usable.length, W }, `均量检查：${symbol}, ${ruleCfg.windowMinutes}m成交量${sumTurnover} 没有超过均值 ${avgW}，不发送`);
              return;
            }
            logger.info({ usable: usable.length, W }, `均量检查：${symbol}, ${ruleCfg.windowMinutes}m成交量${sumTurnover} 超过均值 ${avgW}，发送告警`);
          } else {
            logger.warn({ usable: usable.length, W }, '均量检查：可用数据不足，不发送');
            return
          }
        } else {
          logger.warn({ len: Array.isArray(data) ? data.length : -1, need: limit }, '均量检查：返回 K 线数量异常，不发送');
          return
        }
      } else {
        logger.warn({ status: resp.status }, '均量检查：请求 K 线失败，不发送');
        return
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, '均量检查：发生异常，不发送');
    return
  }

  // 构建原因文案与倍数
  const reasonLine = (helpers.marketCapMaxUsd > 0)
    ? `市值低于$${(helpers.marketCapMaxUsd/1_000_000).toFixed(2)}M且${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`
    : `${helpers.windowMinutes}m成交额超过$${(helpers.thresholdUsd/1_000_000).toFixed(2)}M`;
  const ratio = (typeof marketCap === 'number' && marketCap > 0) ? (sumTurnover / marketCap) : undefined;

  const text = buildStrategyText(ctx, reasonLine, helpers);
  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio,
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct
  }, { strategy: `${helpers.windowMinutes}m_turnover`, text });
}
