import logger from './logger.js';
import { fetch24hrAll } from './binance_futures.js';
import { saveUniverseSnapshot } from './db.js';

function floorTo12hUTCms(d = new Date()) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  const h = t.getUTCHours();
  const h12 = Math.floor(h / 12) * 12;
  t.setUTCHours(h12);
  return t.getTime();
}

function buildUniverseFrom24h(data) {
  const filtered = data
    .filter(x => x.symbol && x.symbol.endsWith('USDT'))
    .filter(x => x.symbol !== 'ETHUSDT' && x.symbol !== 'SOLUSDT')
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0));
  const selected = filtered.slice(50, 130).map(x => x.symbol);
  return { ranked: filtered.map(x => x.symbol), selected };
}

async function main() {
  const tsPeriod = floorTo12hUTCms(new Date());
  logger.info({ tsPeriod }, '开始生成12小时Universe快照');
  const all = await fetch24hrAll();
  const uni = buildUniverseFrom24h(all);
  await saveUniverseSnapshot({ ts_period: tsPeriod, symbols_ranked: uni.ranked, selected_51_130: uni.selected });
  logger.info({ tsPeriod, ranked: uni.ranked.length, selected: uni.selected.length }, '12小时Universe快照已保存');
}

main().catch(e => {
  logger.error({ err: String(e) }, 'symbols_update 失败');
  process.exit(1);
});
