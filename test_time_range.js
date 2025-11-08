/**
 * 测试时间范围处理是否正确
 */

console.log('测试时间范围处理\n');

const now = Date.now();
console.log('当前时间:', new Date(now).toISOString());

// 测试 _alignToMinute
function alignToMinute(ts) {
  return Math.floor(ts / 60000) * 60000;
}

const alignedNow = alignToMinute(now);
console.log('对齐到分钟:', new Date(alignedNow).toISOString());

// 测试检查范围
const retentionHours = 12;
const fromTs = alignToMinute(now - retentionHours * 3600 * 1000);
const toTs = alignToMinute(now) - 60000; // 上一个已完成的分钟

console.log('\n检查范围:');
console.log('从:', new Date(fromTs).toISOString(), `(${fromTs})`);
console.log('到:', new Date(toTs).toISOString(), `(${toTs})`);

// 验证 toTs 不是未来时间
const isFuture = toTs > now;
console.log('\ntoTs 是否是未来时间:', isFuture ? '❌ 是' : '✅ 否');

// 测试 findMissingMinutes 的保护逻辑
const maxToTs = Math.floor(now / 60000) * 60000 - 60000;
console.log('\nfindMissingMinutes 最大允许时间:');
console.log('maxToTs:', new Date(maxToTs).toISOString(), `(${maxToTs})`);

// 模拟传入未来时间
const futureToTs = alignToMinute(now) + 60000; // 下一分钟
console.log('\n模拟传入未来时间:');
console.log('futureToTs:', new Date(futureToTs).toISOString(), `(${futureToTs})`);

const actualToTs = Math.min(futureToTs, maxToTs);
console.log('实际使用时间:', new Date(actualToTs).toISOString(), `(${actualToTs})`);
console.log('是否被限制:', futureToTs > actualToTs ? '✅ 是' : '❌ 否');

// 计算应该检查的分钟数
const totalMinutes = (toTs - fromTs) / 60000;
console.log('\n应该检查的分钟数:', totalMinutes);
console.log('预期值:', retentionHours * 60);

if (Math.abs(totalMinutes - retentionHours * 60) <= 1) {
  console.log('✅ 时间范围正确');
} else {
  console.log('❌ 时间范围不正确');
}

console.log('\n测试完成');
