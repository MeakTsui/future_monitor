import { klineCache } from './kline_redis_cache.js';
import { klineRestClient } from './kline_rest_client.js';
import { isRedisConnected } from './redis_client.js';
import logger from './logger.js';

/**
 * K 线数据完整性检查和修复
 */
export class KlineIntegrityChecker {
  constructor(symbols, config = {}) {
    this.symbols = symbols || [];
    this.checkIntervalMs = (config.checkIntervalMinutes || 5) * 60 * 1000;
    this.retentionHours = config.retentionHours || 12;
    this.restBaseUrl = config.restBaseUrl || 'https://fapi.binance.com';
    this.refreshRecentMinutes = config.refreshRecentMinutes || 0; // 滚动刷新最近 N 分钟（0 表示禁用）
    this.isRunning = false;
    this.timer = null;
    this.lastCheckTime = new Map(); // symbol -> lastCheckTs
    this.failedTimestamps = new Map(); // symbol -> Set<timestamp> 记录无法修复的时间戳
    this.invalidSymbols = new Set(); // 记录无效的交易对（已下架、暂停等）
  }

  /**
   * 启动定时检查
   */
  start() {
    if (this.isRunning) {
      logger.warn('K 线完整性检查已在运行中');
      return;
    }

    this.isRunning = true;
    logger.info({ 
      symbols: this.symbols.length, 
      checkIntervalMinutes: this.checkIntervalMs / 60000,
      retentionHours: this.retentionHours 
    }, 'K 线完整性检查启动');

    // 立即执行第一次检查
    this._executeCheck();
  }

  /**
   * 停止定时检查
   */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info('K 线完整性检查已停止');
  }

  /**
   * 执行检查并调度下一次检查
   */
  async _executeCheck() {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.checkAndRepairAll();
    } catch (err) {
      logger.error({ err: err.message }, '完整性检查执行失败');
    }

    // 调度下一次检查
    this._scheduleNextCheck();
  }

  /**
   * 调度下一次检查
   */
  _scheduleNextCheck() {
    if (!this.isRunning) {
      return;
    }

    this.timer = setTimeout(() => {
      this._executeCheck();
    }, this.checkIntervalMs);
  }

  /**
   * 检查并修复所有交易对的数据
   */
  async checkAndRepairAll() {
    if (!isRedisConnected()) {
      logger.debug('Redis 未连接，跳过完整性检查');
      return;
    }

    logger.info({ symbols: this.symbols.length }, '开始 K 线完整性检查');
    const startTime = Date.now();

    let checkedCount = 0;
    let repairedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    // 分批处理，避免 API 限流
    const batchSize = 50; // 每批处理 50 个交易对
    const batchDelay = 5000; // 每批之间延迟 5 秒

    for (let i = 0; i < this.symbols.length; i += batchSize) {
      const batch = this.symbols.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(this.symbols.length / batchSize);

      logger.info({ 
        batch: batchNum, 
        totalBatches, 
        symbols: batch.length 
      }, `处理第 ${batchNum}/${totalBatches} 批交易对`);

      // 逐个检查当前批次
      for (const symbol of batch) {
        try {
          const repaired = await this.checkAndRepairSymbol(symbol);
          checkedCount++;
          if (repaired > 0) {
            repairedCount++;
          } else if (repaired === -1) {
            // -1 表示跳过（无需修复）
            skippedCount++;
          }
        } catch (err) {
          errorCount++;
          logger.warn({ symbol, err: err.message }, '单个交易对检查失败');
        }

        // 每检查一个交易对，延迟 200ms（避免过快）
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // 批次之间延迟，避免触发限流
      if (i + batchSize < this.symbols.length) {
        logger.debug({ 
          nextBatch: batchNum + 1, 
          delayMs: batchDelay 
        }, '等待处理下一批...');
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }

    const duration = Date.now() - startTime;
    
    // 记录无效交易对信息
    if (this.invalidSymbols.size > 0) {
      logger.warn({ 
        count: this.invalidSymbols.size,
        symbols: Array.from(this.invalidSymbols).slice(0, 10) // 只显示前 10 个
      }, '发现无效交易对（已下架或暂停）');
    }
    
    logger.info({ 
      checkedCount, 
      repairedCount, 
      skippedCount,
      invalidCount: this.invalidSymbols.size,
      errorCount, 
      durationMs: duration,
      durationMinutes: (duration / 60000).toFixed(2)
    }, 'K 线完整性检查完成');
  }

  /**
   * 检查并修复单个交易对的数据
   * @param {string} symbol - 交易对符号
   * @returns {Promise<number>} 修复的数据条数
   */
  async checkAndRepairSymbol(symbol) {
    if (!isRedisConnected()) {
      return 0;
    }

    // 跳过已知的无效交易对
    if (this.invalidSymbols.has(symbol)) {
      logger.debug({ symbol }, '跳过无效交易对');
      return -1; // -1 表示跳过
    }

    const now = Date.now();

    // 如果启用了滚动刷新，先刷新最近 N 分钟的数据
    if (this.refreshRecentMinutes > 0) {
      await this._refreshRecentData(symbol, now);
    }

    // 检查时间范围：最近 12 小时，但不包括当前正在进行的分钟
    const fromTs = this._alignToMinute(now - this.retentionHours * 3600 * 1000);
    // toTs 设置为上一个已完成的分钟（当前分钟 - 1 分钟）
    const toTs = this._alignToMinute(now) - 60000;

    // 如果 toTs <= fromTs，说明时间范围无效，跳过检查
    if (toTs <= fromTs) {
      logger.debug({ symbol, fromTs, toTs }, '时间范围无效，跳过检查');
      return 0;
    }

    // 查找缺失的分钟桶
    const missingMinutes = await klineCache.findMissingMinutes(symbol, fromTs, toTs);

    if (missingMinutes.length === 0) {
      logger.debug({ symbol }, 'K 线数据完整，无需修复');
      return -1; // -1 表示跳过（数据完整）
    }

    // 过滤掉边界数据（在保留时间边界附近 2 分钟内的数据）
    // 这些数据即将被清理，不值得修复
    const boundaryThreshold = 120000; // 2 分钟
    const retentionMs = this.retentionHours * 3600 * 1000;
    const filteredMissing = missingMinutes.filter(ts => {
      const ageMs = now - ts;
      return Math.abs(ageMs - retentionMs) >= boundaryThreshold;
    });

    // 记录过滤掉的边界数据
    const boundaryCount = missingMinutes.length - filteredMissing.length;
    if (boundaryCount > 0) {
      logger.debug({ 
        symbol, 
        totalMissing: missingMinutes.length, 
        boundaryFiltered: boundaryCount,
        remaining: filteredMissing.length 
      }, '过滤掉边界数据');
    }

    if (filteredMissing.length === 0) {
      logger.debug({ symbol }, 'K 线数据完整（排除边界数据），无需修复');
      return -1; // -1 表示跳过（数据完整）
    }

    // 如果缺失数据过多（超过 50%），可能是新交易对或 Redis 刚启动，批量拉取
    const totalMinutes = (toTs - fromTs) / 60000;
    const missingRatio = filteredMissing.length / totalMinutes;

    if (missingRatio > 0.5) {
      logger.info({ symbol, missing: filteredMissing.length, total: totalMinutes, ratio: missingRatio.toFixed(2) }, 
        'K 线数据缺失较多，批量拉取');
      return await this._repairBatch(symbol, fromTs, toTs);
    } else {
      logger.info({ symbol, missing: filteredMissing.length }, 'K 线数据有缺失，逐个修复');
      return await this._repairMissing(symbol, filteredMissing);
    }
  }

  /**
   * 批量修复（拉取整个时间范围）
   * @param {string} symbol - 交易对符号
   * @param {number} fromTs - 开始时间戳
   * @param {number} toTs - 结束时间戳
   * @returns {Promise<number>} 修复的数据条数
   */
  async _repairBatch(symbol, fromTs, toTs) {
    try {
      // 确保 toTs 不超过当前时间（减去 1 分钟，避免拉取未完成的 K 线）
      const now = Date.now();
      const maxToTs = this._alignToMinute(now) - 60000;
      const actualToTs = Math.min(toTs, maxToTs);
      
      if (actualToTs <= fromTs) {
        logger.debug({ symbol, fromTs, toTs, actualToTs }, '时间范围无效，跳过批量修复');
        return 0;
      }
      
      // endTime 需要加上 60000，确保包含最后一个时间戳的完整 K 线
      const endTime = actualToTs + 60000;
      const klines = await klineRestClient.getKlinesWithRetry(symbol, '1m', fromTs, endTime);
      
      if (klines.length === 0) {
        logger.warn({ symbol, fromTs, toTs: actualToTs }, '批量拉取 K 线数据为空');
        return 0;
      }

      // 批量保存到 Redis
      await klineCache.saveKlinesBatch(symbol, klines);
      
      logger.info({ symbol, count: klines.length }, 'K 线数据批量修复完成');
      return klines.length;
    } catch (err) {
      // 检查是否是无效交易对错误
      if (this._isInvalidSymbolError(err)) {
        logger.warn({ symbol, err: err.message }, '交易对无效，标记为跳过');
        this.invalidSymbols.add(symbol);
        return -1; // -1 表示跳过
      }
      
      logger.error({ symbol, fromTs, toTs, err: err.message }, '批量修复失败');
      return 0;
    }
  }

  /**
   * 逐个修复缺失的分钟桶
   * @param {string} symbol - 交易对符号
   * @param {Array<number>} missingMinutes - 缺失的时间戳数组
   * @returns {Promise<number>} 修复的数据条数
   */
  async _repairMissing(symbol, missingMinutes) {
    if (missingMinutes.length === 0) {
      return 0;
    }

    // 过滤掉未来的时间戳（当前分钟及之后）
    const now = Date.now();
    const maxTs = this._alignToMinute(now) - 60000; // 上一个已完成的分钟
    let validMissingMinutes = missingMinutes.filter(ts => ts <= maxTs);
    
    // 过滤掉已知无法修复的时间戳（避免重复尝试）
    const failedSet = this.failedTimestamps.get(symbol);
    if (failedSet) {
      const beforeFilter = validMissingMinutes.length;
      validMissingMinutes = validMissingMinutes.filter(ts => !failedSet.has(ts));
      const skipped = beforeFilter - validMissingMinutes.length;
      if (skipped > 0) {
        logger.debug({ symbol, skipped }, '跳过已知无法修复的时间戳');
      }
    }
    
    const filteredCount = missingMinutes.length - validMissingMinutes.length;
    if (filteredCount > 0) {
      logger.debug({ 
        symbol, 
        total: missingMinutes.length,
        valid: validMissingMinutes.length,
        filtered: filteredCount,
        maxTs,
        maxTsDate: new Date(maxTs).toISOString()
      }, '过滤掉未来的时间戳');
    }
    
    if (validMissingMinutes.length === 0) {
      logger.debug({ symbol, filtered: filteredCount }, '过滤后无需修复');
      return 0;
    }

    // 将连续的缺失时间合并为区间，减少 API 调用次数
    const ranges = this._mergeToRanges(validMissingMinutes);
    
    let repairedCount = 0;

    for (const [start, end] of ranges) {
      try {
        // endTime 需要加上 60000，确保包含最后一个时间戳的完整 K 线
        // 例如：要获取 12:00 的 K 线，需要 startTime=12:00, endTime=12:01
        const endTime = end + 60000;
        const klines = await klineRestClient.getKlinesWithRetry(symbol, '1m', start, endTime);
        
        if (klines.length > 0) {
          await klineCache.saveKlinesBatch(symbol, klines);
          repairedCount += klines.length;
        } else {
          // 如果返回 0 条数据，记录为无法修复的时间戳
          if (!this.failedTimestamps.has(symbol)) {
            this.failedTimestamps.set(symbol, new Set());
          }
          const failedSet = this.failedTimestamps.get(symbol);
          
          // 记录这个区间内的所有时间戳
          for (let ts = start; ts <= end; ts += 60000) {
            failedSet.add(ts);
          }
          
          const startDate = new Date(start).toISOString();
          const endDate = new Date(end).toISOString();
          const now = Date.now();
          const isFuture = start > now;
          logger.debug({ 
            symbol, 
            start, 
            end, 
            startDate, 
            endDate,
            isFuture,
            reason: isFuture ? '未来时间' : '交易对可能暂停交易或数据不存在'
          }, '拉取 K 线返回 0 条数据，标记为无法修复');
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        // 检查是否是无效交易对错误
        if (this._isInvalidSymbolError(err)) {
          logger.warn({ symbol, err: err.message }, '交易对无效，标记为跳过');
          this.invalidSymbols.add(symbol);
          return -1; // -1 表示跳过，不再继续修复其他区间
        }
        
        logger.warn({ symbol, start, end, err: err.message }, '修复区间失败');
      }
    }

    logger.info({ symbol, repairedCount, ranges: ranges.length }, 'K 线数据逐个修复完成');
    return repairedCount;
  }

  /**
   * 将离散的时间戳合并为连续区间
   * @param {Array<number>} timestamps - 时间戳数组（毫秒）
   * @returns {Array<[number, number]>} 区间数组 [[start, end], ...]
   * 注意：end 是区间的最后一个时间戳，API 调用时需要 end + 60000 作为 endTime
   */
  _mergeToRanges(timestamps) {
    if (timestamps.length === 0) {
      return [];
    }

    // 排序
    const sorted = [...timestamps].sort((a, b) => a - b);
    const ranges = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const ts = sorted[i];
      // 如果连续（相差 1 分钟），扩展当前区间
      if (ts - rangeEnd === 60000) {
        rangeEnd = ts;
      } else {
        // 否则，保存当前区间，开始新区间
        // 注意：这里保存的是时间戳本身，调用 API 时需要加上区间长度
        ranges.push([rangeStart, rangeEnd]);
        rangeStart = ts;
        rangeEnd = ts;
      }
    }

    // 保存最后一个区间
    ranges.push([rangeStart, rangeEnd]);

    return ranges;
  }

  /**
   * 刷新最近 N 分钟的数据（用历史数据覆盖 WebSocket 数据）
   * @param {string} symbol - 交易对符号
   * @param {number} now - 当前时间戳
   * @returns {Promise<number>} 刷新的数据条数
   */
  async _refreshRecentData(symbol, now) {
    try {
      // 计算刷新范围：最近 N 分钟，但不包括当前正在进行的分钟
      const toTs = this._alignToMinute(now) - 60000; // 上一个已完成的分钟
      const fromTs = toTs - (this.refreshRecentMinutes - 1) * 60000; // 往前推 N-1 分钟
      
      if (fromTs >= toTs) {
        logger.debug({ symbol, fromTs, toTs }, '刷新范围无效');
        return 0;
      }

      // 拉取历史数据（endTime 需要加 60000 以包含最后一分钟）
      const endTime = toTs + 60000;
      const klines = await klineRestClient.getKlinesWithRetry(symbol, '1m', fromTs, endTime);
      
      if (klines.length === 0) {
        logger.debug({ symbol, fromTs, toTs }, '刷新数据为空');
        return 0;
      }

      // 覆盖写入 Redis（已有数据会被替换）
      await klineCache.saveKlinesBatch(symbol, klines);
      
      logger.debug({ 
        symbol, 
        count: klines.length,
        minutes: this.refreshRecentMinutes,
        from: new Date(fromTs).toISOString(),
        to: new Date(toTs).toISOString()
      }, '刷新最近数据完成');
      
      // 刷新后稍微延迟，避免与后续检查调用过于密集
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return klines.length;
    } catch (err) {
      // 检查是否是无效交易对错误
      if (this._isInvalidSymbolError(err)) {
        logger.warn({ symbol, err: err.message }, '交易对无效，标记为跳过');
        this.invalidSymbols.add(symbol);
        return -1;
      }
      
      logger.warn({ symbol, err: err.message }, '刷新最近数据失败');
      return 0;
    }
  }

  /**
   * 对齐到分钟边界
   * @param {number} ts - 时间戳（毫秒）
   * @returns {number} 对齐后的时间戳
   */
  _alignToMinute(ts) {
    return Math.floor(ts / 60000) * 60000;
  }

  /**
   * 判断是否是无效交易对错误
   * @param {Error} err - 错误对象
   * @returns {boolean} 是否是无效交易对错误
   */
  _isInvalidSymbolError(err) {
    if (!err || !err.message) {
      return false;
    }
    
    const message = err.message.toLowerCase();
    
    // Binance API 错误码
    // -1122: Invalid symbol status (交易对状态无效，已下架或暂停)
    // -1121: Invalid symbol (交易对不存在)
    return message.includes('-1122') || 
           message.includes('-1121') ||
           message.includes('invalid symbol');
  }

  /**
   * 手动触发单个交易对的检查和修复
   * @param {string} symbol - 交易对符号
   * @returns {Promise<Object>} 检查结果
   */
  async manualCheck(symbol) {
    const startTime = Date.now();
    
    try {
      const repairedCount = await this.checkAndRepairSymbol(symbol);
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        symbol,
        repairedCount,
        durationMs: duration
      };
    } catch (err) {
      return {
        success: false,
        symbol,
        error: err.message
      };
    }
  }
}

// 全局实例（延迟初始化）
let checkerInstance = null;

/**
 * 初始化并启动完整性检查器
 * @param {Array<string>} symbols - 交易对列表
 * @param {Object} config - 配置
 */
export function startIntegrityChecker(symbols, config) {
  if (checkerInstance) {
    logger.warn('完整性检查器已存在，停止旧实例');
    checkerInstance.stop();
  }

  checkerInstance = new KlineIntegrityChecker(symbols, config);
  checkerInstance.start();
  return checkerInstance;
}

/**
 * 获取完整性检查器实例
 * @returns {KlineIntegrityChecker|null}
 */
export function getIntegrityChecker() {
  return checkerInstance;
}

/**
 * 停止完整性检查器
 */
export function stopIntegrityChecker() {
  if (checkerInstance) {
    checkerInstance.stop();
    checkerInstance = null;
  }
}
