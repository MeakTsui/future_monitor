/**
 * 测试 Binance API 时间范围参数
 */

console.log('测试 Binance API 时间范围\n');

// 模拟场景
const missingTimestamps = [
  1762575120000,  // 单个时间戳
  1762577220000,  // 连续时间戳开始
  1762577280000,  // 连续时间戳
  1762577340000   // 连续时间戳结束
];

console.log('缺失的时间戳:');
missingTimestamps.forEach(ts => {
  console.log(`  ${ts} → ${new Date(ts).toISOString()}`);
});

// 模拟 _mergeToRanges 逻辑
function mergeToRanges(timestamps) {
  if (timestamps.length === 0) return [];
  
  const sorted = [...timestamps].sort((a, b) => a - b);
  const ranges = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const ts = sorted[i];
    if (ts - rangeEnd === 60000) {
      rangeEnd = ts;
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = ts;
      rangeEnd = ts;
    }
  }
  
  ranges.push([rangeStart, rangeEnd]);
  return ranges;
}

const ranges = mergeToRanges(missingTimestamps);

console.log('\n合并后的区间:');
ranges.forEach(([start, end], index) => {
  const startDate = new Date(start).toISOString();
  const endDate = new Date(end).toISOString();
  const count = (end - start) / 60000 + 1;
  
  console.log(`\n区间 ${index + 1}:`);
  console.log(`  start: ${start} → ${startDate}`);
  console.log(`  end:   ${end} → ${endDate}`);
  console.log(`  包含 K 线数: ${count}`);
  
  // 错误的 API 调用（旧逻辑）
  console.log(`\n  ❌ 错误调用: getKlines(symbol, '1m', ${start}, ${end})`);
  if (start === end) {
    console.log(`     问题: startTime === endTime，无法获取数据！`);
  }
  
  // 正确的 API 调用（新逻辑）
  const endTime = end + 60000;
  const endTimeDate = new Date(endTime).toISOString();
  console.log(`\n  ✅ 正确调用: getKlines(symbol, '1m', ${start}, ${endTime})`);
  console.log(`     startTime: ${startDate}`);
  console.log(`     endTime:   ${endTimeDate}`);
  console.log(`     说明: endTime 比最后一个时间戳多 60 秒，确保包含完整的 K 线`);
});

console.log('\n' + '='.repeat(80));
console.log('\nBinance API 时间范围规则:');
console.log('1. startTime: K 线的开始时间（openTime）');
console.log('2. endTime: 必须 > startTime，且应该包含最后一个 K 线的结束时间');
console.log('3. 对于 1 分钟 K 线: endTime 应该至少是 startTime + 60000');
console.log('4. 要获取单根 K 线: endTime = startTime + 60000');
console.log('5. 要获取多根 K 线: endTime = 最后一个 openTime + 60000\n');

console.log('示例:');
console.log('- 获取 12:00 的 K 线: startTime=12:00:00, endTime=12:01:00');
console.log('- 获取 12:00-12:02 的 K 线: startTime=12:00:00, endTime=12:03:00');
console.log('  (包含 12:00, 12:01, 12:02 三根 K 线)\n');
