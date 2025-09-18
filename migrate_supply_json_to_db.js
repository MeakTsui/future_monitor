import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import { upsertSupply } from './db.js';

const SUPPLY_JSON = path.resolve('./supply.json');

function loadSupplyJson() {
  if (!fs.existsSync(SUPPLY_JSON)) {
    throw new Error(`supply.json 不存在: ${SUPPLY_JSON}`);
  }
  const raw = fs.readFileSync(SUPPLY_JSON, 'utf8');
  if (!raw || !raw.trim()) {
    throw new Error('supply.json 内容为空');
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`解析 supply.json 失败: ${e.message}`);
  }
  if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') {
    throw new Error('supply.json 结构不正确，应包含 data 字段');
  }
  return json.data;
}

function parseNumber(x) {
  if (x === null || x === undefined) return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x));
  return Number.isNaN(n) ? null : n;
}

async function migrate() {
  const data = loadSupplyJson();
  const symbols = Object.keys(data);
  let total = 0;
  let imported = 0;
  let skipped = 0;

  for (const sym of symbols) {
    total++;
    const v = data[sym] || {};
    // 跳过 total_supply 为 null 的条目
    if (v.total_supply === null || v.total_supply === undefined) {
      skipped++;
      continue;
    }
    try {
      const entry = {
        symbol: (v.symbol || sym || '').toUpperCase(),
        name: v.name || sym,
        circulating_supply: parseNumber(v.circulating_supply),
        market_cap: parseNumber(v.market_cap),
        total_supply: parseNumber(v.total_supply),
        max_supply: parseNumber(v.max_supply),
        volume_24h_usd: parseNumber(v.volume_24h_usd),
        fully_diluted_market_cap: parseNumber(v.fully_diluted_market_cap),
        rank: v.rank == null ? null : parseInt(v.rank, 10),
        last_updated: v.last_updated || new Date().toISOString(),
      };
      // 再次校验 total_supply 有效
      if (entry.total_supply == null) {
        skipped++;
        continue;
      }
      upsertSupply(entry);
      imported++;
      if (imported % 500 === 0) {
        logger.info({ imported, skipped, progress: `${imported + skipped}/${total}` }, '迁移进度');
      }
    } catch (e) {
      skipped++;
      logger.warn({ sym, err: e.message }, '导入某条目失败，已跳过');
    }
  }

  logger.info({ total, imported, skipped }, 'supply.json -> SQLite 迁移完成');
}

migrate().catch(err => {
  logger.error({ err: err.message }, '迁移过程发生错误');
  process.exit(1);
});
