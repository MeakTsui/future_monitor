import { createClient } from 'redis';
import logger from './logger.js';

let redisClient = null;
let isConnected = false;

/**
 * 初始化 Redis 客户端
 * @param {Object} config - Redis 配置 { host, port, password, db }
 * @returns {Promise<Object>} Redis 客户端实例
 */
export async function initRedisClient(config) {
  if (redisClient) {
    return redisClient;
  }

  const { host = 'localhost', port = 6379, password, db = 0 } = config || {};

  try {
    const clientConfig = {
      socket: {
        host,
        port,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis 重连次数超过限制，停止重连');
            return new Error('Redis 重连失败');
          }
          const delay = Math.min(retries * 100, 3000);
          logger.warn({ retries, delay }, 'Redis 连接断开，准备重连');
          return delay;
        }
      },
      database: db
    };

    if (password) {
      clientConfig.password = password;
    }

    redisClient = createClient(clientConfig);

    redisClient.on('error', (err) => {
      logger.error({ err: err.message }, 'Redis 客户端错误');
      isConnected = false;
    });

    redisClient.on('connect', () => {
      logger.info({ host, port, db }, 'Redis 正在连接...');
    });

    redisClient.on('ready', () => {
      logger.info({ host, port, db }, 'Redis 连接成功');
      isConnected = true;
    });

    redisClient.on('reconnecting', () => {
      logger.warn('Redis 正在重连...');
      isConnected = false;
    });

    redisClient.on('end', () => {
      logger.warn('Redis 连接已关闭');
      isConnected = false;
    });

    await redisClient.connect();
    return redisClient;
  } catch (err) {
    logger.error({ err: err.message }, 'Redis 初始化失败');
    throw err;
  }
}

/**
 * 获取 Redis 客户端实例
 * @returns {Object|null} Redis 客户端实例或 null
 */
export function getRedisClient() {
  return redisClient;
}

/**
 * 检查 Redis 是否已连接
 * @returns {boolean}
 */
export function isRedisConnected() {
  return isConnected && redisClient && redisClient.isOpen;
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedisClient() {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('Redis 连接已关闭');
    } catch (err) {
      logger.error({ err: err.message }, 'Redis 关闭失败');
    } finally {
      redisClient = null;
      isConnected = false;
    }
  }
}

/**
 * 安全执行 Redis 命令（带错误处理）
 * @param {Function} fn - Redis 命令函数
 * @param {*} defaultValue - 失败时返回的默认值
 * @returns {Promise<*>}
 */
export async function safeRedisCall(fn, defaultValue = null) {
  if (!isRedisConnected()) {
    logger.debug('Redis 未连接，跳过操作');
    return defaultValue;
  }

  try {
    return await fn();
  } catch (err) {
    logger.warn({ err: err.message }, 'Redis 操作失败');
    return defaultValue;
  }
}
