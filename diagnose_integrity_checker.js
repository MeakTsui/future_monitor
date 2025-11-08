/**
 * 诊断完整性检查器问题
 */

console.log('开始诊断...\n');

// 1. 检查模块导入
console.log('1. 检查模块导入...');
try {
  const { klineCache } = await import('./kline_redis_cache.js');
  console.log('✅ kline_redis_cache.js 导入成功');
  console.log('   - klineCache:', typeof klineCache);
  console.log('   - findMissingMinutes:', typeof klineCache.findMissingMinutes);
} catch (err) {
  console.log('❌ kline_redis_cache.js 导入失败:', err.message);
}

try {
  const { klineRestClient } = await import('./kline_rest_client.js');
  console.log('✅ kline_rest_client.js 导入成功');
  console.log('   - klineRestClient:', typeof klineRestClient);
  console.log('   - getKlinesWithRetry:', typeof klineRestClient.getKlinesWithRetry);
} catch (err) {
  console.log('❌ kline_rest_client.js 导入失败:', err.message);
}

try {
  const { isRedisConnected } = await import('./redis_client.js');
  console.log('✅ redis_client.js 导入成功');
  console.log('   - isRedisConnected:', typeof isRedisConnected);
} catch (err) {
  console.log('❌ redis_client.js 导入失败:', err.message);
}

try {
  const logger = (await import('./logger.js')).default;
  console.log('✅ logger.js 导入成功');
  console.log('   - logger:', typeof logger);
} catch (err) {
  console.log('❌ logger.js 导入失败:', err.message);
}

// 2. 检查完整性检查器
console.log('\n2. 检查完整性检查器...');
try {
  const { KlineIntegrityChecker, startIntegrityChecker, getIntegrityChecker, stopIntegrityChecker } = await import('./kline_integrity_checker.js');
  console.log('✅ kline_integrity_checker.js 导入成功');
  console.log('   - KlineIntegrityChecker:', typeof KlineIntegrityChecker);
  console.log('   - startIntegrityChecker:', typeof startIntegrityChecker);
  console.log('   - getIntegrityChecker:', typeof getIntegrityChecker);
  console.log('   - stopIntegrityChecker:', typeof stopIntegrityChecker);
  
  // 3. 尝试创建实例
  console.log('\n3. 尝试创建实例...');
  const checker = new KlineIntegrityChecker(['BTCUSDT'], {
    checkIntervalMinutes: 5,
    retentionHours: 12,
    restBaseUrl: 'https://fapi.binance.com'
  });
  console.log('✅ 实例创建成功');
  console.log('   - symbols:', checker.symbols);
  console.log('   - checkIntervalMs:', checker.checkIntervalMs);
  console.log('   - retentionHours:', checker.retentionHours);
  console.log('   - restBaseUrl:', checker.restBaseUrl);
  
  // 4. 检查方法
  console.log('\n4. 检查方法...');
  console.log('   - start:', typeof checker.start);
  console.log('   - stop:', typeof checker.stop);
  console.log('   - checkAndRepairAll:', typeof checker.checkAndRepairAll);
  console.log('   - checkAndRepairSymbol:', typeof checker.checkAndRepairSymbol);
  console.log('   - manualCheck:', typeof checker.manualCheck);
  
  console.log('\n✅ 所有检查通过！完整性检查器模块正常');
  
} catch (err) {
  console.log('❌ kline_integrity_checker.js 有问题:', err.message);
  console.log('堆栈:', err.stack);
}

console.log('\n诊断完成');
