// 示例自定义策略：当 sumTurnover 超过 2x 阈值，同时市值过滤通过时发送额外提醒
// 导出默认函数，签名为 (ctx, config, helpers) => void | Promise<void>
// ctx 包含：symbol, openTime, sumTurnover, closePrice, marketCap, prevForDisplay, closeForDisplay, deltaPct, trendEmoji
// helpers：{ windowMinutes, thresholdUsd, marketCapMaxUsd, cooldownSec, shouldAlertLocal, shouldAlert, markAlertSentLocal, markAlertSent, buildReasonLine, notify }

export default async function sampleStrategy(ctx, config, helpers) {
  const { symbol, sumTurnover, marketCap, trendEmoji, prevForDisplay, closeForDisplay, deltaPct, closePrice, openTime } = ctx;
  const { thresholdUsd, marketCapMaxUsd } = helpers;

  // 条件：成交额超过阈值 2 倍，且（若启用）市值过滤通过
  const over2x = sumTurnover >= thresholdUsd * 2;
  const mcPass = !(marketCapMaxUsd > 0) || (Number.isFinite(marketCap) && marketCap > 0 && marketCap < marketCapMaxUsd);
  if (!over2x || !mcPass) return;

  const reason = `ws_custom_over2x_${helpers.windowMinutes}m_${thresholdUsd}`;
  // 冷却控制（本地 + DB）
  const local = helpers.shouldAlertLocal(symbol, reason, helpers.cooldownSec);
  if (!local.ok) return;
  const db = helpers.shouldAlert(symbol, reason, helpers.cooldownSec);
  if (!db.ok) return;

  // 标记，避免并发重复
  helpers.markAlertSentLocal(symbol, reason);
  helpers.markAlertSent(symbol, reason);

  const reasonLine = `自定义策略：${helpers.windowMinutes}m 成交额超过阈值 2 倍`;
  await helpers.notify(symbol, reasonLine, sumTurnover, { alerts: config.alerts }, {
    trendEmoji,
    marketCap,
    ratio: (Number.isFinite(marketCap) && marketCap > 0) ? (sumTurnover / marketCap) : undefined,
    prevClose: Number.isFinite(prevForDisplay) ? prevForDisplay : undefined,
    closePrice: Number.isFinite(closeForDisplay) ? closeForDisplay : (Number.isFinite(closePrice) ? closePrice : undefined),
    deltaPct
  }, { strategy: `custom_over2x_${helpers.windowMinutes}m` });
}
