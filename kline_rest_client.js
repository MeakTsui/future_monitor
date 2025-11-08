import fetch from 'node-fetch';
import logger from './logger.js';

/**
 * Binance REST API 限流器
 * 币安期货 API 限制：每分钟 2400 请求权重
 */
class RateLimiter {
  constructor(maxWeight = 2000, windowMs = 60000) {
    this.maxWeight = maxWeight;
    this.windowMs = windowMs;
    this.queue = [];
    this.currentWeight = 0;
    this.windowStart = Date.now();
  }

  /**
   * 执行带限流的请求
   * @param {number} weight - 请求权重
   * @param {Function} fn - 请求函数
   * @returns {Promise<*>}
   */
  async request(weight, fn) {
    // 等待权重可用
    await this._waitForWeight(weight);

    try {
      const result = await fn();
      this._consumeWeight(weight);
      return result;
    } catch (err) {
      this._consumeWeight(weight);
      throw err;
    }
  }

  async _waitForWeight(weight) {
    while (true) {
      this._resetWindowIfNeeded();

      if (this.currentWeight + weight <= this.maxWeight) {
        return;
      }

      // 等待到下一个窗口
      const waitMs = this.windowMs - (Date.now() - this.windowStart);
      if (waitMs > 0) {
        logger.debug({ waitMs, currentWeight: this.currentWeight, maxWeight: this.maxWeight }, '限流等待中');
        await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 1000)));
      }
    }
  }

  _consumeWeight(weight) {
    this.currentWeight += weight;
  }

  _resetWindowIfNeeded() {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.currentWeight = 0;
    }
  }
}

/**
 * Binance 期货 REST API 客户端
 */
export class KlineRestClient {
  constructor(baseUrl = 'https://fapi.binance.com', rateLimitConfig = {}) {
    this.baseUrl = baseUrl;
    this.rateLimiter = new RateLimiter(
      rateLimitConfig.maxWeight || 2000,
      rateLimitConfig.windowMs || 60000
    );
  }

  /**
   * 获取 K 线数据
   * @param {string} symbol - 交易对符号
   * @param {string} interval - K 线间隔（1m, 5m, 15m, 1h, 1d）
   * @param {number} startTime - 开始时间戳（毫秒）
   * @param {number} endTime - 结束时间戳（毫秒）
   * @param {number} limit - 返回数量限制（默认 500，最大 1500）
   * @returns {Promise<Array>} K 线数据数组
   */
  async getKlines(symbol, interval = '1m', startTime, endTime, limit = 500) {
    const weight = this._calculateWeight(limit);
    
    return await this.rateLimiter.request(weight, async () => {
      const params = new URLSearchParams({
        symbol,
        interval,
        limit: Math.min(limit, 1500).toString()
      });

      if (startTime) {
        params.append('startTime', startTime.toString());
      }
      if (endTime) {
        params.append('endTime', endTime.toString());
      }

      const url = `${this.baseUrl}/fapi/v1/klines?${params.toString()}`;

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        });

        if (!response.ok) {
          const text = await response.text();
          logger.warn({ url, status: response.status, text }, 'Binance API 请求失败');
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();

        // 转换为标准格式
        return data.map(k => ({
          t: k[0],           // openTime
          o: k[1],           // open
          h: k[2],           // high
          l: k[3],           // low
          c: k[4],           // close
          v: k[5],           // volume (base asset)
          q: k[7],           // quote volume (USDT)
          n: k[8]            // number of trades
        }));
      } catch (err) {
        logger.error({ url, err: err.message }, 'Binance API 请求异常');
        throw err;
      }
    });
  }

  /**
   * 批量获取多个时间段的 K 线数据（自动分页）
   * @param {string} symbol - 交易对符号
   * @param {string} interval - K 线间隔
   * @param {number} startTime - 开始时间戳（毫秒）
   * @param {number} endTime - 结束时间戳（毫秒）
   * @returns {Promise<Array>} K 线数据数组
   */
  async getKlinesBatch(symbol, interval = '1m', startTime, endTime) {
    const allKlines = [];
    let currentStart = startTime;
    const batchSize = 1500; // 每次最多拉取 1500 条

    // 计算每个批次的时间跨度（1m = 60000ms）
    const intervalMs = this._getIntervalMs(interval);
    const batchTimeSpan = batchSize * intervalMs;

    while (currentStart < endTime) {
      const currentEnd = Math.min(currentStart + batchTimeSpan, endTime);

      try {
        const klines = await this.getKlines(symbol, interval, currentStart, currentEnd, batchSize);
        
        if (klines.length === 0) {
          break;
        }

        allKlines.push(...klines);

        // 移动到下一个批次
        const lastKline = klines[klines.length - 1];
        currentStart = lastKline.t + intervalMs;

        // 如果返回的数据少于请求的数量，说明已经到达最新数据
        if (klines.length < batchSize) {
          break;
        }

        // 避免请求过快，稍微延迟
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err) {
        logger.error({ symbol, currentStart, currentEnd, err: err.message }, '批量获取 K 线失败');
        throw err;
      }
    }

    logger.info({ symbol, interval, count: allKlines.length, from: startTime, to: endTime }, '批量获取 K 线完成');
    return allKlines;
  }

  /**
   * 带重试的获取 K 线数据
   * @param {string} symbol - 交易对符号
   * @param {string} interval - K 线间隔
   * @param {number} startTime - 开始时间戳（毫秒）
   * @param {number} endTime - 结束时间戳（毫秒）
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise<Array>} K 线数据数组
   */
  async getKlinesWithRetry(symbol, interval, startTime, endTime, maxRetries = 3) {
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.getKlinesBatch(symbol, interval, startTime, endTime);
      } catch (err) {
        lastError = err;
        const delay = Math.min(1000 * Math.pow(2, i), 10000); // 指数退避
        logger.warn({ symbol, attempt: i + 1, maxRetries, delay, err: err.message }, 'K 线获取失败，准备重试');
        
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * 计算请求权重
   * @param {number} limit - 请求数量
   * @returns {number} 权重
   */
  _calculateWeight(limit) {
    // 根据 Binance 文档：
    // limit <= 100: weight = 1
    // 100 < limit <= 500: weight = 2
    // 500 < limit <= 1000: weight = 5
    // 1000 < limit: weight = 10
    if (limit <= 100) return 1;
    if (limit <= 500) return 2;
    if (limit <= 1000) return 5;
    return 10;
  }

  /**
   * 获取时间间隔对应的毫秒数
   * @param {string} interval - 时间间隔
   * @returns {number} 毫秒数
   */
  _getIntervalMs(interval) {
    const map = {
      '1m': 60000,
      '3m': 180000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
      '1h': 3600000,
      '2h': 7200000,
      '4h': 14400000,
      '6h': 21600000,
      '8h': 28800000,
      '12h': 43200000,
      '1d': 86400000,
      '3d': 259200000,
      '1w': 604800000,
      '1M': 2592000000
    };
    return map[interval] || 60000;
  }
}

// 导出单例实例
export const klineRestClient = new KlineRestClient();
