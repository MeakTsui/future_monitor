import fs from 'fs';
import logger from './logger.js';
import { initRedisClient, isRedisConnected, closeRedisClient } from './redis_client.js';
import { KlineIntegrityChecker } from './kline_integrity_checker.js';

/**
 * 测试完整性检查器
 */

const CONFIG_FILE = './config.json';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    logger.error({ err: err.message }, '配置文件加载失败');
    process.exit(1);
  }
}

async function testIntegrityChecker() {
  const config = loadConfig();

  // 设置日志级别
  if (config.logLevel) {
    try {
      logger.level = config.logLevel;
    } catch {}
  }

  // 初始化 Redis
  if (!config.redis || !config.klineCache?.enabled) {
    logger.error('Redis 或 K 线缓存未配置，请检查 config.json');
    process.exit(1);
  }

  try {
    await initRedisClient(config.redis);
    logger.info('Redis 连接成功');
  } catch (err) {
    logger.error({ err: err.message }, 'Redis 连接失败');
    process.exit(1);
  }

  if (!isRedisConnected()) {
    logger.error('Redis 未连接');
    process.exit(1);
  }

  // 测试交易对列表（只测试几个）
  const testSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

  const integrityConfig = {
    checkIntervalMinutes: 1, // 测试时设置为 1 分钟
    retentionHours: config.klineCache.retentionHours || 12,
    restBaseUrl: config.klineCache.restApiBaseUrl || 'https://fapi.binance.com'
  };

  console.log('\n========== 完整性检查器测试 ==========\n');
  console.log(`测试交易对: ${testSymbols.join(', ')}`);
  console.log(`检查间隔: ${integrityConfig.checkIntervalMinutes} 分钟`);
  console.log(`保留时长: ${integrityConfig.retentionHours} 小时`);
  console.log(`REST API: ${integrityConfig.restBaseUrl}\n`);

  try {
    // 创建检查器实例
    const checker = new KlineIntegrityChecker(testSymbols, integrityConfig);

    console.log('1. 测试单个交易对检查...\n');
    
    for (const symbol of testSymbols) {
      console.log(`检查 ${symbol}...`);
      const result = await checker.manualCheck(symbol);
      
      if (result.success) {
        console.log(`✅ ${symbol}: 修复了 ${result.repairedCount} 条数据，耗时 ${result.durationMs}ms\n`);
      } else {
        console.log(`❌ ${symbol}: 检查失败 - ${result.error}\n`);
      }
    }

    console.log('2. 测试批量检查...\n');
    await checker.checkAndRepairAll();

    console.log('\n3. 测试定时检查（运行 10 秒后停止）...\n');
    checker.start();
    
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    checker.stop();
    console.log('\n定时检查已停止\n');

    console.log('========== 测试完成 ==========\n');
    console.log('✅ 完整性检查器工作正常\n');

  } catch (err) {
    console.error('\n❌ 测试失败:', err.message);
    console.error('堆栈:', err.stack);
    process.exit(1);
  } finally {
    await closeRedisClient();
  }
}

testIntegrityChecker().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
