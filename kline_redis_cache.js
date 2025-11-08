import { getRedisClient, isRedisConnected, safeRedisCall } from './redis_client.js';
import logger from './logger.js';

/**
 * K 线 Redis 缓存管理类
 */
export class KlineRedisCache {
  constructor(retentionHours = 12) {
    this.retentionMs = retentionHours * 3600 * 1000;
    this.retentionHours = retentionHours;
    // 节流：记录每个 symbol+timestamp 的最后写入时间
    this.lastWriteTime = new Map(); // key: "symbol:timestamp" -> lastWriteMs
    this.throttleMs = 1000; // 同一分钟的 K 线最多每秒写入一次
  }

  /**
   * 保存 K 线数据到 Redis（滑动窗口）
   * @param {string} symbol - 交易对符号
   * @param {Object} klineData - K 线数据 { o, h, l, c, v, q, t, n, x }
   */
  async saveKline(symbol, klineData) {
    if (!isRedisConnected()) {
      return;
    }

    // 节流检查：同一分钟的 K 线最多每秒写入一次（除非已关闭）
    const throttleKey = `${symbol}:${klineData.t}`;
    const now = Date.now();
    const lastWrite = this.lastWriteTime.get(throttleKey) || 0;
    const isClosed = klineData.x === true;
    
    // 如果未关闭且距离上次写入不到 1 秒，跳过（节流）
    if (!isClosed && (now - lastWrite < this.throttleMs)) {
      return;
    }
    
    // 更新最后写入时间
    this.lastWriteTime.set(throttleKey, now);
    
    // 清理过期的节流记录（保留最近 5 分钟）
    if (this.lastWriteTime.size > 1000) {
      const cutoffTime = now - 5 * 60 * 1000;
      for (const [key, time] of this.lastWriteTime.entries()) {
        if (time < cutoffTime) {
          this.lastWriteTime.delete(key);
        }
      }
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;
    const score = klineData.t; // openTime (毫秒时间戳)
    const value = JSON.stringify({
      o: klineData.o, // open
      h: klineData.h, // high
      l: klineData.l, // low
      c: klineData.c, // close
      v: klineData.v, // volume (base asset)
      q: klineData.q, // quote volume (USDT)
      t: klineData.t, // openTime
      n: klineData.n, // number of trades
      x: klineData.x !== undefined ? klineData.x : true // is closed (默认 true 兼容旧数据)
    });

    await safeRedisCall(async () => {
      // 1. 先删除相同时间戳的所有数据（因为 value 不同时 Sorted Set 不会自动覆盖）
      await redis.zRemRangeByScore(key, score, score);
      
      // 2. 添加新数据
      await redis.zAdd(key, { score, value });

      // 3. 滑动窗口清理：删除超过保留时长的数据（每 10 次写入执行一次）
      if (Math.random() < 0.1) {
        const cutoff = Date.now() - this.retentionMs;
        await redis.zRemRangeByScore(key, '-inf', cutoff);
      }

      // 4. 兜底 TTL：防止长期不活跃的 symbol 占用内存
      if (Math.random() < 0.1) {
        await redis.expire(key, Math.floor((this.retentionMs / 1000) * 2));
      }

      // 仅在 K 线关闭时记录日志
      if (isClosed) {
        logger.debug({ symbol, openTime: klineData.t, closed: true }, 'K 线已关闭并保存到 Redis');
      }
    });
  }

  /**
   * 批量保存 K 线数据
   * @param {string} symbol - 交易对符号
   * @param {Array} klineDataArray - K 线数据数组
   */
  async saveKlinesBatch(symbol, klineDataArray) {
    if (!isRedisConnected() || !Array.isArray(klineDataArray) || klineDataArray.length === 0) {
      return;
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;

    await safeRedisCall(async () => {
      // 1. 先删除所有要写入的时间戳的旧数据（去重）
      const timestamps = [...new Set(klineDataArray.map(k => k.t))]; // 去重时间戳
      for (const timestamp of timestamps) {
        await redis.zRemRangeByScore(key, timestamp, timestamp);
      }

      // 2. 批量写入新数据
      const members = klineDataArray.map(klineData => ({
        score: klineData.t,
        value: JSON.stringify({
          o: klineData.o,
          h: klineData.h,
          l: klineData.l,
          c: klineData.c,
          v: klineData.v,
          q: klineData.q,
          t: klineData.t,
          n: klineData.n,
          x: klineData.x !== undefined ? klineData.x : true // is closed (默认 true 兼容旧数据)
        })
      }));

      await redis.zAdd(key, members);

      // 3. 清理过期数据
      const cutoff = Date.now() - this.retentionMs;
      await redis.zRemRangeByScore(key, '-inf', cutoff);

      // 4. 设置 TTL
      await redis.expire(key, Math.floor((this.retentionMs / 1000) * 2));

      logger.info({ symbol, count: klineDataArray.length }, 'K 线数据批量保存到 Redis');
    });
  }

  /**
   * 查询指定时间范围的 K 线数据
   * @param {string} symbol - 交易对符号
   * @param {number} fromTs - 开始时间戳（毫秒）
   * @param {number} toTs - 结束时间戳（毫秒）
   * @returns {Promise<Array>} K 线数据数组
   */
  async getKlines(symbol, fromTs, toTs) {
    if (!isRedisConnected()) {
      return [];
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;
    const from = fromTs || '-inf';
    const to = toTs || '+inf';

    return await safeRedisCall(async () => {
      const results = await redis.zRangeByScore(key, from, to);
      return results.map(json => {
        try {
          return JSON.parse(json);
        } catch (e) {
          logger.warn({ symbol, json }, 'K 线数据解析失败');
          return null;
        }
      }).filter(Boolean);
    }, []);
  }

  /**
   * 获取最新的 K 线数据
   * @param {string} symbol - 交易对符号
   * @returns {Promise<Object|null>} K 线数据或 null
   */
  async getLatestKline(symbol) {
    if (!isRedisConnected()) {
      return null;
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;

    return await safeRedisCall(async () => {
      const results = await redis.zRange(key, -1, -1);
      if (results.length === 0) {
        return null;
      }
      try {
        return JSON.parse(results[0]);
      } catch (e) {
        logger.warn({ symbol }, '最新 K 线数据解析失败');
        return null;
      }
    }, null);
  }

  /**
   * 获取 K 线数据数量
   * @param {string} symbol - 交易对符号
   * @returns {Promise<number>} K 线数据数量
   */
  async getKlineCount(symbol) {
    if (!isRedisConnected()) {
      return 0;
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;

    return await safeRedisCall(async () => {
      return await redis.zCard(key);
    }, 0);
  }

  /**
   * 检查指定时间范围内缺失的分钟桶
   * @param {string} symbol - 交易对符号
   * @param {number} fromTs - 开始时间戳（毫秒，分钟对齐）
   * @param {number} toTs - 结束时间戳（毫秒，分钟对齐）
   * @returns {Promise<Array<number>>} 缺失的时间戳数组（毫秒）
   */
  async findMissingMinutes(symbol, fromTs, toTs) {
    if (!isRedisConnected()) {
      return [];
    }

    // 确保 toTs 不超过当前时间（减去 1 分钟，避免检查未完成的 K 线）
    const now = Date.now();
    const maxToTs = Math.floor(now / 60000) * 60000 - 60000; // 上一个已完成的分钟
    const actualToTs = Math.min(toTs, maxToTs);

    // 如果时间范围无效，返回空数组
    if (actualToTs < fromTs) {
      return [];
    }

    const klines = await this.getKlines(symbol, fromTs, actualToTs);
    if (klines.length === 0) {
      // 如果没有数据，返回整个范围的所有分钟
      const missing = [];
      for (let ts = fromTs; ts <= actualToTs; ts += 60000) {
        missing.push(ts);
      }
      return missing;
    }

    // 构建已存在的时间戳集合
    const existingSet = new Set(klines.map(k => k.t));

    // 查找缺失的分钟
    const missing = [];
    for (let ts = fromTs; ts <= actualToTs; ts += 60000) {
      if (!existingSet.has(ts)) {
        missing.push(ts);
      }
    }

    return missing;
  }

  /**
   * 删除指定 symbol 的所有 K 线数据
   * @param {string} symbol - 交易对符号
   */
  async clearSymbol(symbol) {
    if (!isRedisConnected()) {
      return;
    }

    const redis = getRedisClient();
    const key = `kline:1m:${symbol}`;

    await safeRedisCall(async () => {
      await redis.del(key);
      logger.info({ symbol }, 'K 线数据已清空');
    });
  }

  /**
   * 获取所有已缓存的 symbol 列表
   * @returns {Promise<Array<string>>} symbol 列表
   */
  async getAllSymbols() {
    if (!isRedisConnected()) {
      return [];
    }

    const redis = getRedisClient();

    return await safeRedisCall(async () => {
      const keys = await redis.keys('kline:1m:*');
      return keys.map(key => key.replace('kline:1m:', ''));
    }, []);
  }
}

// 导出单例实例
export const klineCache = new KlineRedisCache(12);
