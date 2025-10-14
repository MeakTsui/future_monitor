import logger from './logger.js';
import { fetchKlines1m, batchSequential, sleep } from './binance_futures.js';
import { getLatestUniverseSnapshotBefore, upsertAvgVolHourly } from './db.js';

function floorToHourUTCms(d = new Date()) {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t.getTime();
}

function sliceLastMinutesFromKlines(klines, minutes) {
  if (!Array.isArray(klines) || klines.length === 0) return [];
  const needMs = minutes * 60000;
  const endMs = klines[klines.length - 1].openTime;
  const startMs = endMs - needMs + 60000;
  let i = klines.length - 1;
  while (i >= 0 && klines[i].openTime >= startMs) i--;
  return klines.slice(i + 1);
}

function sumVolumes(klines) {
  let s = 0;
  for (const k of klines) s += Number(k.volume || 0);
  return s;
}

async function computeAndSave(tsHour) {
  const snap = getLatestUniverseSnapshotBefore(tsHour);
  const symbols = ['ETHUSDT', 'SOLUSDT', ...(snap.selected_51_130 || [])];
  logger.info({ tsHour, symbols: symbols.length }, '开始计算每小时 avg_vol_5m_5h');

  await batchSequential(symbols, async (sym) => {
    try {
      const ks = await fetchKlines1m(sym, 320);
      const last300 = sliceLastMinutesFromKlines(ks, 300);
      const vol5h = sumVolumes(last300);
      const avg5m = vol5h / 60;
      await upsertAvgVolHourly({ ts_hour: tsHour, symbol: sym, avg_vol_5m_5h: avg5m });
      logger.debug({ sym, avg5m: Number(avg5m.toFixed(6)) }, '保存 avg_vol_5m_5h');
    } catch (e) {
      logger.warn({ sym, err: String(e) }, '计算 avg_vol_5m_5h 失败');
    }
    await sleep(50);
  }, 50);

  logger.info({ tsHour }, '本小时 avg_vol_5m_5h 计算完成');
}

async function main() {
  const tsHour = floorToHourUTCms(new Date());
  await computeAndSave(tsHour);
}

main().catch(e => {
  logger.error({ err: String(e) }, 'avg_vol_hourly 失败');
  process.exit(1);
});
