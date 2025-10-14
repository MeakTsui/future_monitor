import fs from "fs";
import path from "path";
import logger from "../../logger.js";

// Provider to persist market state total_score into a CSV file.
// Configuration example in config.json alerts list:
// {
//   "provider": "csv_market_state",
//   "enabled": true,
//   "path": "./market_state.csv" // optional, default: ./market_state.csv
// }
export default async function csvMarketStateProvider({ payload, providerConfig }) {
  try {
    const metrics = payload && payload.metrics ? payload.metrics : null;
    const raw = metrics && typeof metrics.total_score === 'number' ? metrics.total_score : null;
    if (raw === null) return; // nothing to record

    const total = Number(raw);
    if (!Number.isFinite(total)) return;

    const filePath = (providerConfig && typeof providerConfig.path === 'string' && providerConfig.path.trim())
      ? providerConfig.path
      : './market_state.csv';

    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const dir = path.dirname(abs);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    // write header if not exists
    const exists = fs.existsSync(abs);
    if (!exists) {
      fs.writeFileSync(abs, 'time,total_score\n', { encoding: 'utf8' });
    }

    const nowIso = new Date().toISOString();
    const row = `${nowIso},${total.toFixed(3)}\n`;
    fs.appendFileSync(abs, row, { encoding: 'utf8' });
  } catch (e) {
    logger.warn({ err: e.message }, 'csv_market_state provider 写入失败');
  }
}
