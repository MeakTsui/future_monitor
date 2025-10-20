#!/usr/bin/env node
// 测试市场状态计算逻辑
import { getAllSymbolsWithCirculatingSupply } from './db.js';
import { computeMarketStateRealtime } from './market_state_calculator.js';
import logger from './logger.js';

logger.level = 'debug';

async function test() {
  console.log('=== 测试市场状态计算 ===\n');
  
  // 1. 测试数据库查询
  console.log('1. 查询有流通供应量的币种...');
  const supplies = getAllSymbolsWithCirculatingSupply();
  console.log(`   找到 ${supplies.length} 个币种\n`);
  
  if (supplies.length > 0) {
    console.log('   前5个币种示例:');
    supplies.slice(0, 5).forEach(s => {
      console.log(`   - ${s.symbol}: ${s.circulating_supply.toLocaleString()}`);
    });
    console.log('');
  }
  
  // 2. 模拟数据读取器
  console.log('2. 创建模拟数据读取器...');
  const mockPrices = new Map([
    ['BTCUSDT', 65000],
    ['ETHUSDT', 3500],
    ['SOLUSDT', 150],
    ['BNBUSDT', 580],
  ]);
  
  const mockReader = {
    getPrice: (symbol) => {
      return mockPrices.get(symbol) || Math.random() * 100; // 随机价格
    },
    getWindow: (symbol) => {
      // 模拟5分钟K线数据
      const now = Date.now();
      const data = [];
      for (let i = 4; i >= 0; i--) {
        const openTime = now - i * 60000;
        data.push({
          openTime,
          open: 100 + Math.random() * 10,
          low: 95 + Math.random() * 5,
          close: 100 + Math.random() * 10,
          volume: 1000000 + Math.random() * 500000
        });
      }
      return Promise.resolve(data);
    }
  };
  
  console.log('   模拟价格示例:');
  mockPrices.forEach((price, symbol) => {
    console.log(`   - ${symbol}: $${price.toLocaleString()}`);
  });
  console.log('');
  
  // 3. 执行计算
  console.log('3. 执行市场状态计算...');
  const startTime = Date.now();
  
  try {
    const result = await computeMarketStateRealtime(Date.now(), mockReader, {
      maxMarketCapUsd: 500_000_000,
      maxSymbols: 100
    });
    
    const elapsed = Date.now() - startTime;
    
    console.log(`   计算完成，耗时: ${elapsed}ms\n`);
    
    if (result) {
      console.log('4. 计算结果:');
      console.log(`   - 价格得分: ${result.price_score.toFixed(2)}`);
      console.log(`   - 成交量得分: ${result.volume_score.toFixed(2)}`);
      console.log(`   - 参与计算币种数: ${result.rows ? result.rows.length : 0}`);
      console.log(`   - 状态: ${result.state_text || 'null'}\n`);
      
      if (result.rows && result.rows.length > 0) {
        console.log('5. 前10个币种详情:');
        result.rows.slice(0, 10).forEach((row, idx) => {
          console.log(`   ${idx + 1}. ${row.symbol}`);
          console.log(`      价格得分: ${row.price_score.toFixed(4)}, 成交量得分: ${row.vol_score.toFixed(4)}`);
          console.log(`      权重: ${row.weight.toFixed(6)}, 总分: ${row.symbol_score.toFixed(4)}`);
        });
        console.log('');
        
        // 验证权重总和
        const totalWeight = result.rows.reduce((sum, r) => sum + r.weight, 0);
        console.log(`6. 权重验证:`);
        console.log(`   权重总和: ${totalWeight.toFixed(6)} (应接近 1.0)`);
        
        if (Math.abs(totalWeight - 1.0) > 0.01) {
          console.log(`   ⚠️  警告: 权重总和偏离1.0较多!`);
        } else {
          console.log(`   ✓ 权重总和正常`);
        }
      }
    } else {
      console.log('   ⚠️  计算返回空结果');
    }
    
  } catch (e) {
    console.error('计算失败:', e.message);
    console.error(e.stack);
  }
  
  console.log('\n=== 测试完成 ===');
}

test().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
