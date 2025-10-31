#!/usr/bin/env node
// 测试市场指标发送器
import { getLatestMarketVolumeScore } from './db.js';
import { computeWeightedMarketStateMA } from './market_state_aggregator.js';
import logger from './logger.js';

async function testGetMetrics() {
  console.log('='.repeat(60));
  console.log('测试市场指标获取');
  console.log('='.repeat(60));
  
  const metrics = {
    market_price_score: null,
    market_volume_score_2: null,
    market_price_score_1h: null,
  };

  // 1. 测试获取 market_volume_score_2
  console.log('\n1. 获取 market_volume_score_2...');
  try {
    const mvs = getLatestMarketVolumeScore();
    if (mvs) {
      console.log('   原始数据:', mvs);
      if (typeof mvs.market_volume_score_2 === 'number') {
        metrics.market_volume_score_2 = Number(mvs.market_volume_score_2.toFixed(4));
        console.log('   ✓ market_volume_score_2:', metrics.market_volume_score_2);
      } else {
        console.log('   ✗ market_volume_score_2 不是数字');
      }
    } else {
      console.log('   ✗ 未找到数据');
    }
  } catch (e) {
    console.error('   ✗ 错误:', e.message);
  }

  // 2. 测试获取 market_price_score 和 market_price_score_1h
  console.log('\n2. 计算 market_price_score 和 market_price_score_1h...');
  try {
    const priceMap = new Map();
    const startTime = Date.now();
    const marketStateMA = await computeWeightedMarketStateMA(500_000_000, priceMap);
    const elapsed = Date.now() - startTime;
    
    console.log(`   计算耗时: ${elapsed}ms`);
    
    if (marketStateMA && marketStateMA.ma5) {
      console.log('   MA5 数据:', {
        price_score: marketStateMA.ma5.price_score,
        volume_score: marketStateMA.ma5.volume_score,
        symbols_count: marketStateMA.ma5.symbols_count,
      });
      metrics.market_price_score = Number(marketStateMA.ma5.price_score.toFixed(2));
      console.log('   ✓ market_price_score:', metrics.market_price_score);
    } else {
      console.log('   ✗ MA5 数据为空');
    }
    
    if (marketStateMA && marketStateMA.ma60) {
      console.log('   MA60 数据:', {
        price_score: marketStateMA.ma60.price_score,
        volume_score: marketStateMA.ma60.volume_score,
        symbols_count: marketStateMA.ma60.symbols_count,
      });
      metrics.market_price_score_1h = Number(marketStateMA.ma60.price_score.toFixed(2));
      console.log('   ✓ market_price_score_1h:', metrics.market_price_score_1h);
    } else {
      console.log('   ✗ MA60 数据为空');
    }
  } catch (e) {
    console.error('   ✗ 错误:', e.message);
    console.error('   堆栈:', e.stack);
  }

  // 3. 显示最终 payload
  console.log('\n3. 最终 Payload:');
  const payload = {
    type: 0,
    market_price_score: metrics.market_price_score,
    market_volume_score_2: metrics.market_volume_score_2,
    market_price_score_1h: metrics.market_price_score_1h,
  };
  console.log(JSON.stringify(payload, null, 2));

  // 4. 检查是否有数据
  const hasData = metrics.market_price_score !== null 
    || metrics.market_volume_score_2 !== null 
    || metrics.market_price_score_1h !== null;

  console.log('\n4. 数据检查:');
  if (hasData) {
    console.log('   ✓ 至少有一个指标可用，可以发送');
  } else {
    console.log('   ✗ 所有指标均为空，将跳过发送');
  }

  console.log('\n' + '='.repeat(60));
  console.log('测试完成');
  console.log('='.repeat(60));
}

// 运行测试
testGetMetrics().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
