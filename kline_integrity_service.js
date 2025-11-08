import fs from 'fs';
import logger from './logger.js';
import { initRedisClient, closeRedisClient, isRedisConnected } from './redis_client.js';
import { klineCache } from './kline_redis_cache.js';
import { KlineIntegrityChecker } from './kline_integrity_checker.js';

/**
 * K 线完整性检查服务 - 独立常驻进程
 * 定期检查 Redis 中所有交易对的 K 线数据完整性，并自动修复缺失数据
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

async function getSymbolList(config) {
  // 优先使用白名单
  if (config.symbolWhitelist && config.symbolWhitelist.length > 0) {
    logger.info({ count: config.symbolWhitelist.length }, '使用白名单交易对');
    return config.symbolWhitelist;
  }

  // 从 Redis 获取所有已缓存的交易对
  try {
    const symbols = await klineCache.getAllSymbols();
    if (symbols.length > 0) {
      logger.info({ count: symbols.length }, '从 Redis 获取交易对列表');
      return symbols;
    }
  } catch (err) {
    logger.warn({ err: err.message }, '从 Redis 获取交易对列表失败');
  }

  logger.error('无法获取交易对列表，请配置 symbolWhitelist 或确保 Redis 中有数据');
  process.exit(1);
}

async function main() {
  logger.info('K 线完整性检查服务启动中...');

  const config = loadConfig();

  // 设置日志级别
  if (config.logLevel) {
    try {
      logger.level = config.logLevel;
    } catch (err) {
      logger.warn({ err: err.message }, '设置日志级别失败');
    }
  }

  // 检查配置
  if (!config.redis || !config.klineCache?.enabled) {
    logger.error('Redis 或 K 线缓存未配置，请检查 config.json');
    process.exit(1);
  }

  // 初始化 Redis
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

  // 获取交易对列表
  const symbols = await getSymbolList(config);
  logger.info({ count: symbols.length }, '交易对列表加载完成');

  // 配置完整性检查器
  const integrityConfig = {
    checkIntervalMinutes: config.klineCache.checkIntervalMinutes || 5,
    retentionHours: config.klineCache.retentionHours || 12,
    restBaseUrl: config.klineCache.restApiBaseUrl || 'https://fapi.binance.com',
    refreshRecentMinutes: config.klineCache.refreshRecentMinutes,
  };

  logger.info({
    checkIntervalMinutes: integrityConfig.checkIntervalMinutes,
    retentionHours: integrityConfig.retentionHours,
    restBaseUrl: integrityConfig.restBaseUrl
  }, 'K 线完整性检查器配置');

  // 创建并启动完整性检查器
  const checker = new KlineIntegrityChecker(symbols, integrityConfig);
  checker.start();

  logger.info('K 线完整性检查服务已启动');

  // 优雅退出处理
  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    logger.info({ signal }, '收到退出信号，开始优雅关闭...');

    try {
      // 停止完整性检查器
      checker.stop();
      logger.info('完整性检查器已停止');

      // 关闭 Redis 连接
      await closeRedisClient();
      logger.info('Redis 连接已关闭');

      logger.info('服务已安全关闭');
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, '关闭过程中发生错误');
      process.exit(1);
    }
  }

  // 监听退出信号
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 监听未捕获的异常
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, '未捕获的异常');
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, '未处理的 Promise 拒绝');
  });

  // 定期输出服务状态（每小时）
  setInterval(() => {
    logger.info({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      symbols: symbols.length
    }, 'K 线完整性检查服务运行状态');
  }, 3600000); // 1 小时
}

main().catch(err => {
  logger.error({ err: err.message, stack: err.stack }, 'K 线完整性检查服务启动失败');
  process.exit(1);
});
