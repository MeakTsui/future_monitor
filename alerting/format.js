// Formatting helpers and default text/payload builders

export function formatNumber(n, digits = 2) {
  if (typeof n !== 'number' || isNaN(n)) return String(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatCurrency(n, digits = 2) {
  if (typeof n !== 'number' || isNaN(n)) return String(n);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatCurrencyCompact(n, digits = 2) {
  if (typeof n !== 'number' || isNaN(n)) return String(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const fmt = (v, suffix = '') => `${sign}$${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
  if (abs >= 1e12) return fmt(abs / 1e12, 'T');
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'K');
  return fmt(abs, '');
}

export function buildBinanceFuturesUrl(contractSymbol) {
  return `https://www.binance.com/en/futures/${contractSymbol}`;
}

export function buildDefaultText({ symbol, reasonLine, sumTurnover, marketCap, ratio, prevClose, closePrice, deltaPct, trendEmoji }) {
  const lines = [];
  const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
  lines.push(`‼️‼️${link} ${trendEmoji || ''}`.trim());
  if (reasonLine) lines.push(`原因: ${reasonLine}`);
  lines.push(`成交量(USD): ${formatCurrencyCompact(sumTurnover)}`);
  if (typeof marketCap === 'number' && Number.isFinite(marketCap)) {
    lines.push(`市值: ${formatCurrencyCompact(marketCap)}`);
  }
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    const digits = ratio < 0.01 ? 4 : 2;
    lines.push(`倍数: ${formatNumber(ratio, digits)}`);
  }
  if (typeof prevClose === 'number' && Number.isFinite(prevClose) && typeof closePrice === 'number' && Number.isFinite(closePrice)) {
    const pctText = (typeof deltaPct === 'number' && Number.isFinite(deltaPct)) ? ` (${deltaPct >= 0 ? '+' : ''}${formatNumber(deltaPct * 100)}%)` : '';
    lines.push(`价格: ${formatCurrency(prevClose)} → ${formatCurrency(closePrice)}${pctText} ${trendEmoji || ''}`.trim());
  }
  return lines.join('\n');
}

export function buildAlertPayload({
  strategy = "",
  symbol = "",
  reason = "",
  windowMinutes,
  severity = "info",
  metrics = {},
  links = {},
  timestamps = {},
  tags = [],
  extra = {},
} = {}) {
  return {
    version: 1,
    source: "future_monitor",
    strategy,
    symbol,
    reason,
    windowMinutes,
    severity,
    metrics,
    links,
    timestamps,
    tags,
    ...extra,
  };
}
