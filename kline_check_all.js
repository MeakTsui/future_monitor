import fs from 'fs';
import logger from './logger.js';
import { initRedisClient, closeRedisClient, isRedisConnected } from './redis_client.js';
import { klineCache } from './kline_redis_cache.js';
import { KlineIntegrityChecker } from './kline_integrity_checker.js';

/**
 * 独立程序：检查 Redis 中所有交易对的 K 线数据完整性
 * 用法：
 *   node kline_check_all.js              # 检查所有交易对
 *   node kline_check_all.js --repair     # 检查并修复
 *   node kline_check_all.js --symbol BTCUSDT  # 检查单个交易对
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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    repair: false,
    symbol: null,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repair' || args[i] === '-r') {
      options.repair = true;
    } else if (args[i] === '--symbol' || args[i] === '-s') {
      options.symbol = args[i + 1]?.toUpperCase();
      i++;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      options.verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
K 线数据完整性检查工具

用法:
  node kline_check_all.js [选项]

选项:
  --repair, -r              检查并自动修复缺失的数据
  --symbol SYMBOL, -s       只检查指定的交易对
  --verbose, -v             显示详细信息
  --help, -h                显示帮助信息

示例:
  # 检查所有交易对（只报告，不修复）
  node kline_check_all.js

  # 检查并修复所有交易对
  node kline_check_all.js --repair

  # 检查单个交易对
  node kline_check_all.js --symbol BTCUSDT

  # 检查并修复单个交易对
  node kline_check_all.js --symbol BTCUSDT --repair
      `);
      process.exit(0);
    }
  }

  return options;
}

async function checkAllSymbols(options, config) {
  console.log('\n========== K 线数据完整性检查 ==========\n');

  // 获取所有已缓存的交易对
  let symbols;
  if (options.symbol) {
    symbols = [options.symbol];
    console.log(`检查交易对: ${options.symbol}`);
  } else {
    symbols = await klineCache.getAllSymbols();
    console.log(`找到 ${symbols.length} 个已缓存的交易对`);
  }

  if (symbols.length === 0) {
    console.log('\n没有找到已缓存的交易对\n');
    return;
  }

  console.log(`检查模式: ${options.repair ? '检查并修复' : '仅检查'}`);
  console.log(`检查范围: 最近 ${config.klineCache.retentionHours || 12} 小时\n`);

  const integrityConfig = {
    checkIntervalMinutes: 5,
    retentionHours: config.klineCache.retentionHours || 12,
    restBaseUrl: config.klineCache.restApiBaseUrl || 'https://fapi.binance.com'
  };

  const checker = new KlineIntegrityChecker(symbols, integrityConfig);

  const results = {
    total: symbols.length,
    complete: 0,
    missing: 0,
    repaired: 0,
    failed: 0,
    details: []
  };

  const startTime = Date.now();

  // 逐个检查
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const progress = `[${i + 1}/${symbols.length}]`;

    try {
      // 检查缺失的数据
      const now = Date.now();
      const fromTs = Math.floor((now - integrityConfig.retentionHours * 3600 * 1000) / 60000) * 60000;
      const toTs = Math.floor(now / 60000) * 60000 - 60000;

      const missingMinutes = await klineCache.findMissingMinutes(symbol, fromTs, toTs);
      const totalMinutes = (toTs - fromTs) / 60000;
      const missingCount = missingMinutes.length;
      const missingRatio = (missingCount / totalMinutes * 100).toFixed(2);

      if (missingCount === 0) {
        results.complete++;
        if (options.verbose) {
          console.log(`${progress} ✅ ${symbol}: 数据完整 (${totalMinutes} 条)`);
        }
      } else {
        results.missing++;
        console.log(`${progress} ⚠️  ${symbol}: 缺失 ${missingCount} 条 (${missingRatio}%)`);

        const detail = {
          symbol,
          totalMinutes,
          missingCount,
          missingRatio: parseFloat(missingRatio),
          repaired: 0
        };

        // 如果启用修复模式
        if (options.repair) {
          console.log(`   正在修复...`);
          const repaired = await checker.checkAndRepairSymbol(symbol);
          detail.repaired = repaired;
          
          if (repaired > 0) {
            results.repaired++;
            console.log(`   ✅ 已修复 ${repaired} 条数据`);
          } else {
            console.log(`   ⚠️  修复失败或无数据可修复`);
          }
        }

        results.details.push(detail);
      }

      // 每检查 10 个交易对，稍微延迟一下
      if ((i + 1) % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (err) {
      results.failed++;
      console.log(`${progress} ❌ ${symbol}: 检查失败 - ${err.message}`);
    }
  }

  const duration = Date.now() - startTime;

  // 输出汇总
  console.log('\n' + '='.repeat(60));
  console.log('\n检查完成:\n');
  console.log(`总交易对数: ${results.total}`);
  console.log(`数据完整: ${results.complete} (${(results.complete / results.total * 100).toFixed(2)}%)`);
  console.log(`数据缺失: ${results.missing} (${(results.missing / results.total * 100).toFixed(2)}%)`);
  
  if (options.repair) {
    console.log(`已修复: ${results.repaired}`);
  }
  
  if (results.failed > 0) {
    console.log(`检查失败: ${results.failed}`);
  }
  
  console.log(`总耗时: ${(duration / 1000).toFixed(2)} 秒\n`);

  // 显示缺失最多的前 10 个交易对
  if (results.details.length > 0) {
    console.log('缺失数据最多的交易对 (前 10):\n');
    const sorted = results.details.sort((a, b) => b.missingCount - a.missingCount).slice(0, 10);
    
    for (const detail of sorted) {
      const status = options.repair && detail.repaired > 0 ? '✅ 已修复' : '⚠️  待修复';
      console.log(`  ${detail.symbol.padEnd(15)} 缺失: ${detail.missingCount.toString().padStart(4)} 条 (${detail.missingRatio.toFixed(2)}%) ${status}`);
    }
    console.log('');
  }

  // 建议
  if (results.missing > 0 && !options.repair) {
    console.log('💡 提示: 使用 --repair 参数可以自动修复缺失的数据\n');
  }

  if (results.repaired > 0) {
    console.log('✅ 数据修复完成！建议再次运行检查以验证修复结果\n');
  }
}

async function main() {
  const options = parseArgs();
  const config = loadConfig();

  // 设置日志级别
  if (config.logLevel) {
    try {
      logger.level = config.logLevel;
    } catch {}
  }

  // 初始化 Redis
  if (!config.redis || !config.klineCache?.enabled) {
    console.error('❌ Redis 或 K 线缓存未配置，请检查 config.json');
    process.exit(1);
  }

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

  try {
    await checkAllSymbols(options, config);
  } catch (err) {
    console.error('\n❌ 检查失败:', err.message);
    console.error('堆栈:', err.stack);
    process.exit(1);
  } finally {
    await closeRedisClient();
  }
}

main().catch(err => {
  console.error('程序执行失败:', err);
  process.exit(1);
});
