import fs from 'fs';
import logger from './logger.js';
import { initRedisClient, isRedisConnected, closeRedisClient } from './redis_client.js';
import { klineCache } from './kline_redis_cache.js';
import { klineRestClient } from './kline_rest_client.js';

/**
 * K 线数据初始化工具
 * 从 Binance REST API 拉取最近 12 小时的数据并写入 Redis
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

/**
 * 获取交易对列表
 */
async function getSymbolList(config) {
  // 优先使用白名单
  if (Array.isArray(config.symbolWhitelist) && config.symbolWhitelist.length > 0) {
    return config.symbolWhitelist.map(s => s.toUpperCase());
  }

  // 否则从 Binance 获取
  const restBaseUrl = config.rule3ws?.restBaseUrl || 'https://fapi.binance.com';
  const url = `${restBaseUrl}/fapi/v1/exchangeInfo`;

  try {
    const fetch = (await import('node-fetch')).default;
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ status: resp.status }, '获取交易对列表失败');
      return [];
    }
    const data = await resp.json();
    const symbols = data.symbols
      .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map(s => s.symbol);

    // 限制数量
    const maxSymbols = 1000000;
    return maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
  } catch (err) {
    logger.error({ err: err.message }, '获取交易对列表异常');
    return [];
  }
}

/**
 * 初始化单个交易对的 K 线数据
 */
async function initSymbolKlines(symbol, retentionHours, restBaseUrl) {
  const now = Date.now();
  const startTime = now - retentionHours * 3600 * 1000;
  const endTime = now;

  logger.info({ symbol, retentionHours }, '开始初始化 K 线数据');

  try {
    // 从 Binance 拉取数据
    const klines = await klineRestClient.getKlinesWithRetry(
      symbol,
      '1m',
      startTime,
      endTime,
      3 // 最多重试 3 次
    );

    if (klines.length === 0) {
      logger.warn({ symbol }, 'K 线数据为空，可能是新上线的交易对');
      return { symbol, success: true, count: 0, skipped: true };
    }

    // 批量写入 Redis
    await klineCache.saveKlinesBatch(symbol, klines);

    logger.info({ symbol, count: klines.length }, 'K 线数据初始化完成');
    return { symbol, success: true, count: klines.length };
  } catch (err) {
    logger.error({ symbol, err: err.message }, 'K 线数据初始化失败');
    return { symbol, success: false, error: err.message };
  }
}

/**
 * 批量初始化所有交易对
 */
async function initAllKlines(symbols, retentionHours, restBaseUrl, concurrency = 3) {
  logger.info({ symbols: symbols.length, retentionHours, concurrency }, '开始批量初始化 K 线数据');

  const results = [];
  const startTime = Date.now();

  // 分批处理，避免并发过多
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(symbol => initSymbolKlines(symbol, retentionHours, restBaseUrl))
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({ success: false, error: result.reason?.message || 'unknown error' });
      }
    }

    // 进度提示
    const progress = Math.min(i + concurrency, symbols.length);
    logger.info({ progress, total: symbols.length }, `初始化进度: ${progress}/${symbols.length}`);

    // 批次间延迟，避免请求过快
    if (i + concurrency < symbols.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const duration = Date.now() - startTime;
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.filter(r => !r.success).length;
  const totalKlines = results.reduce((sum, r) => sum + (r.count || 0), 0);

  logger.info({
    total: symbols.length,
    success: successCount,
    failed: failedCount,
    totalKlines,
    durationMs: duration,
    durationMin: (duration / 60000).toFixed(2)
  }, '批量初始化完成');

  return results;
}

/**
 * 清空指定交易对的 K 线数据
 */
async function clearSymbolKlines(symbol) {
  logger.info({ symbol }, '清空 K 线数据');
  await klineCache.clearSymbol(symbol);
}

/**
 * 清空所有交易对的 K 线数据
 */
async function clearAllKlines() {
  logger.info('清空所有 K 线数据');
  const symbols = await klineCache.getAllSymbols();
  for (const symbol of symbols) {
    await klineCache.clearSymbol(symbol);
  }
  logger.info({ count: symbols.length }, '清空完成');
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'init';

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

  const retentionHours = config.klineCache.retentionHours || 12;
  const restBaseUrl = config.klineCache.restApiBaseUrl || 'https://fapi.binance.com';
  const concurrency = config.klineCache.initConcurrency || 3;

  try {
    switch (command) {
      case 'init': {
        // 初始化所有交易对
        const symbols = await getSymbolList(config);
        if (symbols.length === 0) {
          logger.error('未找到交易对');
          process.exit(1);
        }
        await initAllKlines(symbols, retentionHours, restBaseUrl, concurrency);
        break;
      }

      case 'init-symbol': {
        // 初始化单个交易对
        const symbol = args[1]?.toUpperCase();
        if (!symbol) {
          logger.error('请指定交易对，例如: node kline_init.js init-symbol BTCUSDT');
          process.exit(1);
        }
        await initSymbolKlines(symbol, retentionHours, restBaseUrl);
        break;
      }

      case 'clear': {
        // 清空所有数据
        await clearAllKlines();
        break;
      }

      case 'clear-symbol': {
        // 清空单个交易对
        const symbol = args[1]?.toUpperCase();
        if (!symbol) {
          logger.error('请指定交易对，例如: node kline_init.js clear-symbol BTCUSDT');
          process.exit(1);
        }
        await clearSymbolKlines(symbol);
        break;
      }

      case 'stats': {
        // 查看统计信息
        const symbols = await klineCache.getAllSymbols();
        logger.info({ count: symbols.length }, '已缓存的交易对数量');
        
        if (args[1] === '--detail') {
          for (const symbol of symbols.slice(0, 10)) {
            const count = await klineCache.getKlineCount(symbol);
            const latest = await klineCache.getLatestKline(symbol);
            logger.info({
              symbol,
              count,
              latestTime: latest ? new Date(latest.t).toISOString() : null
            }, '交易对详情');
          }
          if (symbols.length > 10) {
            logger.info(`... 还有 ${symbols.length - 10} 个交易对`);
          }
        }
        break;
      }

      case 'help':
      default: {
        console.log(`
K 线数据初始化工具

用法:
  node kline_init.js [command] [options]

命令:
  init              初始化所有交易对的 K 线数据（默认）
  init-symbol <SYMBOL>   初始化指定交易对，例如: init-symbol BTCUSDT
  clear             清空所有 K 线数据
  clear-symbol <SYMBOL>  清空指定交易对，例如: clear-symbol BTCUSDT
  stats             查看统计信息
  stats --detail    查看详细统计信息（前 10 个交易对）
  help              显示帮助信息

示例:
  # 初始化所有交易对（从 config.json 读取列表）
  node kline_init.js init

  # 初始化单个交易对
  node kline_init.js init-symbol BTCUSDT

  # 查看统计信息
  node kline_init.js stats

  # 清空所有数据
  node kline_init.js clear

配置:
  在 config.json 中配置:
  - klineCache.retentionHours: 数据保留时长（默认 12 小时）
  - klineCache.initConcurrency: 并发数（默认 3）
  - symbolWhitelist: 交易对白名单（可选）
        `);
        break;
      }
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, '执行失败');
    process.exit(1);
  } finally {
    await closeRedisClient();
    logger.info('程序退出');
  }
}

// 处理未捕获的异常
process.on('unhandledRejection', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '未处理的 Promise 拒绝');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '未捕获的异常');
  process.exit(1);
});

main();
