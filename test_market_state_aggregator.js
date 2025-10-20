#!/usr/bin/env node
// 测试市场状态聚合器
import { computeWeightedMarketStateMA, clearCache } from './market_state_aggregator.js';
import { getLatestMarketStateSymbols, getBatchSymbolStateMinutesHistory } from './db.js';
import logger from './logger.js';

logger.level = 'debug';

async function test() {
  console.log('=== 测试市场状态聚合器 ===\n');
  
  try {
    // 1. 检查数据库中的币种
    console.log('1. 检查最近一次市场状态计算的币种...');
    const symbols = getLatestMarketStateSymbols();
    console.log(`   找到 ${symbols.length} 个币种\n`);
    
    if (symbols.length > 0) {
      console.log('   前10个币种示例:');
      symbols.slice(0, 10).forEach(s => {
        console.log(`   - ${s}`);
      });
      console.log('');
    }
    
    // 2. 检查单个币种的历史数据
    if (symbols.length > 0) {
      console.log('2. 检查单个币种的历史数据...');
      const testSymbol = symbols[0];
      const history5 = getBatchSymbolStateMinutesHistory([testSymbol], 5);
      const history60 = getBatchSymbolStateMinutesHistory([testSymbol], 60);
      
      console.log(`   ${testSymbol} 的 MA5 数据点: ${history5.get(testSymbol)?.length || 0}`);
      console.log(`   ${testSymbol} 的 MA60 数据点: ${history60.get(testSymbol)?.length || 0}\n`);
      
      if (history5.get(testSymbol)?.length > 0) {
        const sample = history5.get(testSymbol)[0];
        console.log('   最新数据示例:');
        console.log(`   - price_score: ${sample.price_score}`);
        console.log(`   - vol_score: ${sample.vol_score}`);
        console.log(`   - weight: ${sample.weight}\n`);
      }
    }
    
    // 3. 测试聚合计算
    console.log('3. 执行市场状态聚合计算...');
    const startTime = Date.now();
    
    // 模拟价格 Map（实际使用中由 ws_rule3_monitor 提供）
    const priceMap = new Map();
    
    const result = await computeWeightedMarketStateMA(500_000_000, priceMap);
    
    const elapsed = Date.now() - startTime;
    console.log(`   计算完成，耗时: ${elapsed}ms\n`);
    
    // 4. 显示结果
    console.log('4. 聚合结果:');
    console.log('   MA5 (5分钟均值):');
    console.log(`   - price_score: ${result.ma5.price_score.toFixed(4)}`);
    console.log(`   - volume_score: ${result.ma5.volume_score.toFixed(4)}`);
    console.log(`   - symbols_count: ${result.ma5.symbols_count}`);
    console.log('');
    console.log('   MA60 (60分钟均值):');
    console.log(`   - price_score: ${result.ma60.price_score.toFixed(4)}`);
    console.log(`   - volume_score: ${result.ma60.volume_score.toFixed(4)}`);
    console.log(`   - symbols_count: ${result.ma60.symbols_count}`);
    console.log('');
    
    // 5. 测试缓存
    console.log('5. 测试缓存机制...');
    const startTime2 = Date.now();
    const result2 = await computeWeightedMarketStateMA(500_000_000, priceMap);
    const elapsed2 = Date.now() - startTime2;
    console.log(`   第二次调用耗时: ${elapsed2}ms (应该 < 5ms，使用缓存)\n`);
    
    // 6. 清除缓存并重新计算
    console.log('6. 清除缓存并重新计算...');
    clearCache();
    const startTime3 = Date.now();
    const result3 = await computeWeightedMarketStateMA(500_000_000, priceMap);
    const elapsed3 = Date.now() - startTime3;
    console.log(`   清除缓存后耗时: ${elapsed3}ms\n`);
    
    // 7. 验证结果一致性
    console.log('7. 验证结果一致性:');
    const consistent = (
      Math.abs(result.ma5.price_score - result3.ma5.price_score) < 0.0001 &&
      Math.abs(result.ma5.volume_score - result3.ma5.volume_score) < 0.0001
    );
    console.log(`   结果一致性: ${consistent ? '✓ 通过' : '✗ 失败'}\n`);
    
    // 8. 性能评估
    console.log('8. 性能评估:');
    if (elapsed < 100) {
      console.log(`   ✓ 计算速度优秀 (${elapsed}ms < 100ms)`);
    } else if (elapsed < 200) {
      console.log(`   ✓ 计算速度良好 (${elapsed}ms < 200ms)`);
    } else {
      console.log(`   ⚠️  计算速度较慢 (${elapsed}ms >= 200ms)`);
    }
    
    if (result.ma5.symbols_count > 0) {
      console.log(`   ✓ MA5 有效数据 (${result.ma5.symbols_count} 个币种)`);
    } else {
      console.log(`   ✗ MA5 无有效数据`);
    }
    
    if (result.ma60.symbols_count > 0) {
      console.log(`   ✓ MA60 有效数据 (${result.ma60.symbols_count} 个币种)`);
    } else {
      console.log(`   ⚠️  MA60 无有效数据（可能是数据积累不足）`);
    }
    
  } catch (e) {
    console.error('\n测试失败:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
  
  console.log('\n=== 测试完成 ===');
}

test().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
