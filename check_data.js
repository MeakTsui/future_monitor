#!/usr/bin/env node
import { getLatestMarketState, getMarketStateHistory } from './db.js';
import logger from './logger.js';

console.log('=== 检查数据库状态 ===\n');

// 1. 检查最新数据
console.log('1. 检查最新数据:');
try {
  const latest = getLatestMarketState();
  if (latest) {
    console.log('✓ 找到最新数据:');
    console.log('  - 时间:', new Date(latest.ts_minute).toISOString());
    console.log('  - Price Score:', latest.price_score);
    console.log('  - Volume Score:', latest.volume_score);
    console.log('  - State:', latest.state);
  } else {
    console.log('✗ 没有找到数据');
    console.log('  提示: 需要运行 market_state_cron.js 来生成数据');
  }
} catch (err) {
  console.log('✗ 查询失败:', err.message);
  console.log('  提示: 数据库表可能还未创建，需要先运行 market_state_cron.js');
}

console.log('\n2. 检查历史数据:');
try {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  const history = getMarketStateHistory(oneHourAgo, now, 100);
  
  if (history && history.length > 0) {
    console.log(`✓ 找到 ${history.length} 条历史数据`);
    console.log('  - 最早:', new Date(history[0].ts_minute).toISOString());
    console.log('  - 最新:', new Date(history[history.length - 1].ts_minute).toISOString());
    
    // 检查数据完整性
    let validCount = 0;
    for (const row of history) {
      if (typeof row.price_score === 'number' && typeof row.volume_score === 'number') {
        validCount++;
      }
    }
    console.log(`  - 有效数据: ${validCount}/${history.length}`);
  } else {
    console.log('✗ 没有找到历史数据');
  }
} catch (err) {
  console.log('✗ 查询失败:', err.message);
}

console.log('\n3. 数据库文件位置:');
console.log('  - ./data.sqlite');

console.log('\n=== 建议 ===');
console.log('如果没有数据，请按以下步骤操作:');
console.log('1. 启动 market_state_cron.js:');
console.log('   node market_state_cron.js');
console.log('');
console.log('2. 等待至少1分钟，让系统生成数据');
console.log('');
console.log('3. 再次运行此脚本检查:');
console.log('   node check_data.js');
console.log('');
console.log('4. 启动 server.js:');
console.log('   node server.js');
console.log('');
console.log('5. 打开 chart_test.html 查看图表');
