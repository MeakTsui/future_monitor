import fs from 'fs';
import logger from './logger.js';
import { initRedisClient, closeRedisClient, isRedisConnected } from './redis_client.js';
import { KlineIntegrityChecker } from './kline_integrity_checker.js';

/**
 * 测试立即检查逻辑
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

async function main() {
  console.log('\n========== 测试立即检查逻辑 ==========\n');

  const config = loadConfig();

  // 初始化 Redis
  try {
    await initRedisClient(config.redis);
    logger.info('Redis 连接成功');
  } catch (err) {
    console.error('❌ Redis 连接失败:', err.message);
    process.exit(1);
  }

  if (!isRedisConnected()) {
    console.error('❌ Redis 未连接');
    process.exit(1);
  }

  // 测试交易对
  const testSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

  // 配置完整性检查器（检查间隔设为 10 秒，方便测试）
  const integrityConfig = {
    checkIntervalMinutes: 0.167, // 10 秒
    retentionHours: 12,
    restBaseUrl: 'https://fapi.binance.com'
  };

  console.log('配置:');
  console.log(`  交易对: ${testSymbols.join(', ')}`);
  console.log(`  检查间隔: ${integrityConfig.checkIntervalMinutes * 60} 秒`);
  console.log(`  保留时长: ${integrityConfig.retentionHours} 小时\n`);

  // 记录时间
  const startTime = Date.now();
  const checkTimes = [];

  // 创建检查器
  const checker = new KlineIntegrityChecker(testSymbols, integrityConfig);

  // 监听检查完成（通过日志）
  const originalCheckAndRepairAll = checker.checkAndRepairAll.bind(checker);
  checker.checkAndRepairAll = async function() {
    const checkStartTime = Date.now();
    const elapsed = ((checkStartTime - startTime) / 1000).toFixed(1);
    checkTimes.push(elapsed);
    
    console.log(`\n[${elapsed}s] 🔍 开始第 ${checkTimes.length} 次检查...`);
    
    await originalCheckAndRepairAll();
    
    const checkDuration = ((Date.now() - checkStartTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ✅ 第 ${checkTimes.length} 次检查完成，耗时 ${checkDuration}s`);
  };

  console.log('启动完整性检查器...\n');
  console.log('预期行为:');
  console.log('  1. 立即执行第一次检查（0 秒）');
  console.log('  2. 10 秒后执行第二次检查');
  console.log('  3. 20 秒后执行第三次检查');
  console.log('  ...\n');

  // 启动检查器
  checker.start();

  // 运行 35 秒后停止
  setTimeout(() => {
    console.log('\n' + '='.repeat(60));
    console.log('\n测试结果:\n');
    
    console.log('检查执行时间点:');
    checkTimes.forEach((time, index) => {
      console.log(`  第 ${index + 1} 次: ${time}s`);
    });

    console.log('\n时间间隔:');
    for (let i = 1; i < checkTimes.length; i++) {
      const interval = (parseFloat(checkTimes[i]) - parseFloat(checkTimes[i - 1])).toFixed(1);
      console.log(`  第 ${i} 次 → 第 ${i + 1} 次: ${interval}s`);
    }

    console.log('\n验证:');
    if (checkTimes.length >= 3) {
      const firstCheck = parseFloat(checkTimes[0]);
      const interval1 = parseFloat(checkTimes[1]) - parseFloat(checkTimes[0]);
      const interval2 = parseFloat(checkTimes[2]) - parseFloat(checkTimes[1]);

      console.log(`  ✅ 第一次检查: ${firstCheck < 2 ? '立即执行 ✓' : '延迟执行 ✗'}`);
      console.log(`  ✅ 检查间隔: ${Math.abs(interval1 - 10) < 2 ? '约 10 秒 ✓' : '不正确 ✗'}`);
      console.log(`  ✅ 间隔一致: ${Math.abs(interval1 - interval2) < 2 ? '一致 ✓' : '不一致 ✗'}`);
    } else {
      console.log('  ⚠️  检查次数不足，无法验证');
    }

    console.log('\n测试完成！\n');

    // 停止检查器
    checker.stop();
    
    // 关闭 Redis
    setTimeout(async () => {
      await closeRedisClient();
      process.exit(0);
    }, 1000);
  }, 35000); // 35 秒
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
