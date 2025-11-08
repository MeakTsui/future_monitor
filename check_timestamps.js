/**
 * 检查问题时间戳
 */

const timestamps = [
  1762575120000,
  1762576320000,
  1762577220000,
  1762577280000,
  1762534140000
];

console.log('检查问题时间戳\n');
console.log('当前时间:', new Date().toISOString(), `(${Date.now()})\n`);

const now = Date.now();
const maxTs = Math.floor(now / 60000) * 60000 - 60000; // 上一个已完成的分钟

console.log('最大允许时间:', new Date(maxTs).toISOString(), `(${maxTs})\n`);
console.log('-'.repeat(80));

for (const ts of timestamps) {
  const date = new Date(ts).toISOString();
  const isFuture = ts > now;
  const isAfterMax = ts > maxTs;
  const shouldFilter = ts > maxTs;
  
  console.log(`\n时间戳: ${ts}`);
  console.log(`日期: ${date}`);
  console.log(`是否未来: ${isFuture ? '❌ 是' : '✅ 否'}`);
  console.log(`超过最大允许: ${isAfterMax ? '❌ 是' : '✅ 否'}`);
  console.log(`应该被过滤: ${shouldFilter ? '✅ 是' : '❌ 否'}`);
  
  if (shouldFilter) {
    console.log('⚠️  这个时间戳应该被过滤掉，不应该尝试拉取');
  }
}

console.log('\n' + '='.repeat(80));
console.log('\n结论:');
console.log('- 如果时间戳 > maxTs，说明是未来时间或当前分钟，应该被过滤');
console.log('- 如果 Binance API 返回 0 条，可能原因：');
console.log('  1. 时间戳是未来时间（不应该请求）');
console.log('  2. 交易对在该时间暂停交易');
console.log('  3. 交易对还未上线');
console.log('  4. 数据确实不存在\n');
