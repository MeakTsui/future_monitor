import fetch from 'node-fetch';

/**
 * 测试 K 线实时更新功能
 * 每秒查询一次最新 K 线，观察未关闭的 K 线是否实时更新
 */

const API_BASE = 'http://localhost:8080';
const SYMBOL = 'BTCUSDT';
const INTERVAL_MS = 1000; // 每秒查询一次

async function getLatestKline() {
  try {
    const response = await fetch(`${API_BASE}/api/klines/latest?symbol=${SYMBOL}`);
    if (!response.ok) {
      console.error(`HTTP ${response.status}: ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    return data.data;
  } catch (err) {
    console.error('查询失败:', err.message);
    return null;
  }
}

async function testRealtimeUpdate() {
  console.log('========== K 线实时更新测试 ==========\n');
  console.log(`交易对: ${SYMBOL}`);
  console.log(`查询间隔: ${INTERVAL_MS}ms`);
  console.log(`API 地址: ${API_BASE}\n`);
  console.log('开始监控...\n');
  console.log('时间\t\t\t开盘\t\t最高\t\t最低\t\t收盘\t\t成交量\t\t\t状态');
  console.log('-'.repeat(120));

  let lastKline = null;
  let updateCount = 0;

  const timer = setInterval(async () => {
    const kline = await getLatestKline();
    
    if (!kline) {
      return;
    }

    const time = new Date(kline.t).toISOString().replace('T', ' ').substring(0, 19);
    const status = kline.x === false ? '进行中 🔄' : '已关闭 ✅';
    
    // 检测是否有更新
    let changed = '';
    if (lastKline && lastKline.t === kline.t) {
      if (lastKline.c !== kline.c || lastKline.q !== kline.q) {
        changed = ' [更新]';
        updateCount++;
      }
    }

    console.log(
      `${time}\t${kline.o}\t${kline.h}\t${kline.l}\t${kline.c}\t${parseFloat(kline.q).toFixed(2)}\t\t${status}${changed}`
    );

    lastKline = kline;
  }, INTERVAL_MS);

  // 运行 30 秒后停止
  setTimeout(() => {
    clearInterval(timer);
    console.log('\n' + '-'.repeat(120));
    console.log(`\n测试完成！共检测到 ${updateCount} 次实时更新\n`);
    
    if (updateCount > 0) {
      console.log('✅ 实时更新功能正常工作');
    } else {
      console.log('⚠️  未检测到实时更新，可能原因：');
      console.log('   1. 当前 K 线已关闭（等待下一分钟开始）');
      console.log('   2. 价格和成交量没有变化');
      console.log('   3. WebSocket 未连接或 Redis 未启用');
    }
    
    console.log('\n提示：');
    console.log('- 进行中的 K 线（x=false）应该每秒更新');
    console.log('- 已关闭的 K 线（x=true）不会再更新');
    console.log('- 每分钟开始时会创建新的 K 线\n');
    
    process.exit(0);
  }, 30000);
}

console.log('提示：请确保以下服务已启动：');
console.log('1. Redis 服务');
console.log('2. node ws_rule3_monitor.js (WebSocket 监控)');
console.log('3. node server.js (HTTP API 服务)\n');

setTimeout(() => {
  testRealtimeUpdate();
}, 2000);
