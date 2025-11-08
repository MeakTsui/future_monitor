import { initRedisClient, closeRedisClient, getRedisClient } from './redis_client.js';
import { klineCache } from './kline_redis_cache.js';
import logger from './logger.js';

/**
 * 清理 Redis 中的重复 K 线数据
 * 对于每个时间戳，只保留最新的一条数据
 */

async function cleanDuplicates() {
  // 初始化 Redis
  await initRedisClient({
    "host": "r-6weyrgvnyoinxwqmekpd.redis.japan.rds.aliyuncs.com",
    "port": 6379,
    "password": "Nbb@123_",
    "db": 0
  });

  const redis = getRedisClient();

  console.log('\n========== 清理 Redis K 线重复数据 ==========\n');

  // 获取所有已缓存的交易对
  const symbols = await klineCache.getAllSymbols();
  console.log(`找到 ${symbols.length} 个交易对\n`);

  let totalCleaned = 0;
  let totalSymbolsCleaned = 0;

  for (const symbol of symbols) {
    const key = `kline:1m:${symbol}`;
    
    // 获取所有数据
    const allData = await redis.zRangeWithScores(key, 0, -1);
    
    if (allData.length === 0) {
      continue;
    }

    // 按时间戳分组
    const groupedByTimestamp = new Map();
    for (const item of allData) {
      const score = item.score;
      if (!groupedByTimestamp.has(score)) {
        groupedByTimestamp.set(score, []);
      }
      groupedByTimestamp.get(score).push(item);
    }

    // 找出有重复的时间戳
    let duplicatesCount = 0;
    const toDelete = [];

    for (const [timestamp, items] of groupedByTimestamp.entries()) {
      if (items.length > 1) {
        duplicatesCount += items.length - 1;
        
        // 保留最后一个（假设是最新的），删除其他的
        for (let i = 0; i < items.length - 1; i++) {
          toDelete.push(items[i].value);
        }
      }
    }

    if (duplicatesCount > 0) {
      // 批量删除重复数据
      if (toDelete.length > 0) {
        await redis.zRem(key, toDelete);
      }
      
      console.log(`✅ ${symbol}: 清理了 ${duplicatesCount} 条重复数据`);
      totalCleaned += duplicatesCount;
      totalSymbolsCleaned++;
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`\n清理完成:`);
  console.log(`- 处理交易对: ${symbols.length}`);
  console.log(`- 清理交易对: ${totalSymbolsCleaned}`);
  console.log(`- 清理数据: ${totalCleaned} 条\n`);

  if (totalCleaned > 0) {
    console.log('✅ 重复数据已清理');
    console.log('   建议重启 ws_rule3_monitor.js 以应用新的写入逻辑\n');
  } else {
    console.log('✅ 没有发现重复数据\n');
  }

  await closeRedisClient();
}

cleanDuplicates().catch(err => {
  console.error('清理失败:', err);
  process.exit(1);
});
