import { initRedisClient, closeRedisClient } from './redis_client.js';
import { klineCache } from './kline_redis_cache.js';
import logger from './logger.js';

/**
 * 检查 Redis 中是否有重复的 K 线数据
 */

async function checkDuplicates() {
  // 初始化 Redis
  await initRedisClient({
    "host": "r-6weyrgvnyoinxwqmekpd.redis.japan.rds.aliyuncs.com",
        "port": 6379,
        "password": "Nbb@123_",
        "db": 0
  });

  console.log('\n========== Redis K 线数据重复检查 ==========\n');

  // 获取所有已缓存的交易对
  const symbols = await klineCache.getAllSymbols();
  console.log(`找到 ${symbols.length} 个交易对\n`);

  let totalChecked = 0;
  let totalDuplicates = 0;

  for (const symbol of symbols.slice(0, 10)) { // 检查前 10 个
    const klines = await klineCache.getKlines(symbol);
    
    if (klines.length === 0) {
      continue;
    }

    // 检查是否有重复的时间戳
    const timestamps = klines.map(k => k.t);
    const uniqueTimestamps = new Set(timestamps);
    
    const duplicateCount = timestamps.length - uniqueTimestamps.size;
    
    if (duplicateCount > 0) {
      console.log(`❌ ${symbol}: 发现 ${duplicateCount} 条重复数据`);
      
      // 找出重复的时间戳
      const timestampCounts = {};
      timestamps.forEach(t => {
        timestampCounts[t] = (timestampCounts[t] || 0) + 1;
      });
      
      const duplicates = Object.entries(timestampCounts)
        .filter(([, count]) => count > 1)
        .map(([ts, count]) => ({ ts: Number(ts), count }));
      
      duplicates.slice(0, 3).forEach(({ ts, count }) => {
        const date = new Date(ts).toISOString();
        console.log(`   时间戳 ${ts} (${date}) 出现 ${count} 次`);
      });
      
      totalDuplicates += duplicateCount;
    } else {
      console.log(`✅ ${symbol}: 无重复数据 (${klines.length} 条)`);
    }
    
    totalChecked++;
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`\n检查完成:`);
  console.log(`- 检查交易对: ${totalChecked}`);
  console.log(`- 发现重复: ${totalDuplicates} 条\n`);

  if (totalDuplicates === 0) {
    console.log('✅ Redis Sorted Set 工作正常，没有重复数据');
    console.log('   相同时间戳的数据会被自动覆盖，这是正确的行为\n');
  } else {
    console.log('❌ 发现重复数据，这不应该发生！');
    console.log('   Sorted Set 应该自动覆盖相同 score 的数据\n');
  }

  console.log('说明:');
  console.log('- Sorted Set 使用时间戳作为 score');
  console.log('- 相同 score 的数据会被自动覆盖（只保留最新的）');
  console.log('- 如果看到多次写入日志，这是正常的（WebSocket 实时更新）');
  console.log('- 但 Redis 中只会保留一条数据\n');

  await closeRedisClient();
}

checkDuplicates().catch(err => {
  console.error('检查失败:', err);
  process.exit(1);
});
