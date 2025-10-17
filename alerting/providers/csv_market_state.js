import fs from "fs";
import path from "path";
import logger from "../../logger.js";

// Provider to persist market state scores into a CSV file.
// Configuration example in config.json alerts list:
// {
//   "provider": "csv_market_state",
//   "enabled": true,
//   "path": "./market_state.csv" // optional, default: ./market_state.csv
// }
export default async function csvMarketStateProvider({ payload, providerConfig }) {
  try {
    const metrics = payload && payload.metrics ? payload.metrics : null;
    if (!metrics) return;

    // 优先使用新版字段 market_price_score 和 market_volume_score
    const priceScore = typeof metrics.market_price_score === 'number' ? metrics.market_price_score : null;
    const volumeScore = typeof metrics.market_volume_score === 'number' ? metrics.market_volume_score : null;
    
    // 兼容旧版 total_score
    const totalScore = typeof metrics.total_score === 'number' ? metrics.total_score : null;
    
    // 如果新旧字段都没有，则跳过
    if (priceScore === null && volumeScore === null && totalScore === null) return;

    const filePath = (providerConfig && typeof providerConfig.path === 'string' && providerConfig.path.trim())
      ? providerConfig.path
      : './market_state.csv';

    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const dir = path.dirname(abs);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    // write header if not exists
    const exists = fs.existsSync(abs);
    if (!exists) {
      fs.writeFileSync(abs, 'time,price_score,volume_score,total_score\n', { encoding: 'utf8' });
    }

    const nowIso = new Date().toISOString();
    const ps = priceScore !== null ? priceScore.toFixed(2) : '';
    const vs = volumeScore !== null ? volumeScore.toFixed(2) : '';
    const ts = totalScore !== null ? totalScore.toFixed(3) : '';
    const row = `${nowIso},${ps},${vs},${ts}\n`;
    fs.appendFileSync(abs, row, { encoding: 'utf8' });
  } catch (e) {
    logger.warn({ err: e.message }, 'csv_market_state provider 写入失败');
  }
}
