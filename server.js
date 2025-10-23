import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getLatestMarketState, getMarketStateHistory, getMarketStateDetails, calculateMovingAverage, getAllSymbols, getAlertsStatsBySymbol, getSymbolAlerts, getLatestMarketVolumeScore, getMarketVolumeScoreHistory } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// TradingView 支持的分辨率映射
const RESOLUTION_MAP = {
  '1': 60000,      // 1分钟
  '5': 300000,     // 5分钟
  '15': 900000,    // 15分钟
  '60': 3600000,   // 1小时
  '240': 14400000, // 4小时
  'D': 86400000,   // 1天
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFound(res) { sendJson(res, 404, { error: 'not_found' }); }

function parseQuery(reqUrl) { return url.parse(reqUrl, true).query || {}; }

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// 添加 CORS 支持（TradingView 需要）
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 聚合分钟数据到指定分辨率
function aggregateToResolution(minuteData, resolutionMs) {
  if (!minuteData || minuteData.length === 0) return [];
  
  const bars = [];
  
  for (let i = 0; i < minuteData.length; i++) {
    const row = minuteData[i];
    
    // 检查必要字段
    if (!row || typeof row.ts_minute !== 'number') continue;
    if (typeof row.price_score !== 'number' || typeof row.volume_score !== 'number') continue;
    
    const barTime = Math.floor(row.ts_minute / resolutionMs) * resolutionMs;
    
    let bar = bars.find(b => b.time === barTime);
    if (!bar) {
      bar = {
        time: barTime,
        open_price: row.price_score,
        high_price: row.price_score,
        low_price: row.price_score,
        close_price: row.price_score,
        open_volume: row.volume_score,
        high_volume: row.volume_score,
        low_volume: row.volume_score,
        close_volume: row.volume_score,
        count: 1
      };
      bars.push(bar);
    } else {
      bar.high_price = Math.max(bar.high_price, row.price_score);
      bar.low_price = Math.min(bar.low_price, row.price_score);
      bar.close_price = row.price_score;
      bar.high_volume = Math.max(bar.high_volume, row.volume_score);
      bar.low_volume = Math.min(bar.low_volume, row.volume_score);
      bar.close_volume = row.volume_score;
      bar.count++;
    }
  }
  
  return bars;
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);
  
  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }
  
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    logger.debug({ method: req.method, path: pathname, query: parsed.query }, '收到 HTTP 请求');
    
    // 1. 根路径 - 返回图表页面
    if (req.method === 'GET' && (pathname === '/' || pathname === '/chart')) {
      try {
        const htmlPath = path.join(__dirname, 'chart_tradingview.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        logger.info({ path: pathname }, '返回图表页面');
        return sendHtml(res, 200, html);
      } catch (err) {
        logger.error({ err: err.message }, '读取图表页面失败');
        return sendHtml(res, 500, '<h1>500 - 页面加载失败</h1><p>' + err.message + '</p>');
      }
    }
    
    // 1.1 监控面板页面（简化版，推荐）
    if (req.method === 'GET' && pathname === '/monitor') {
      try {
        const htmlPath = path.join(__dirname, 'monitor_simple.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        logger.info({ path: pathname }, '返回监控面板页面（简化版）');
        return sendHtml(res, 200, html);
      } catch (err) {
        logger.error({ err: err.message }, '读取监控面板页面失败');
        return sendHtml(res, 500, '<h1>500 - 页面加载失败</h1><p>' + err.message + '</p>');
      }
    }
    
    // 1.1.1 监控面板页面（TradingView 版本）
    if (req.method === 'GET' && pathname === '/monitor/tv') {
      try {
        const htmlPath = path.join(__dirname, 'monitor_dashboard.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        logger.info({ path: pathname }, '返回监控面板页面（TradingView 版）');
        return sendHtml(res, 200, html);
      } catch (err) {
        logger.error({ err: err.message }, '读取监控面板页面失败');
        return sendHtml(res, 500, '<h1>500 - 页面加载失败</h1><p>' + err.message + '</p>');
      }
    }
    
    // 1.1.2 测试页面
    if (req.method === 'GET' && pathname === '/test') {
      try {
        const htmlPath = path.join(__dirname, 'test_symbols.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        logger.info({ path: pathname }, '返回测试页面');
        return sendHtml(res, 200, html);
      } catch (err) {
        logger.error({ err: err.message }, '读取测试页面失败');
        return sendHtml(res, 500, '<h1>500 - 页面加载失败</h1><p>' + err.message + '</p>');
      }
    }
    
    // 1.2 获取所有币种列表
    if (req.method === 'GET' && pathname === '/api/symbols') {
      try {
        const symbols = getAllSymbols();
        logger.info({ count: symbols.length }, '返回币种列表');
        return sendJson(res, 200, { symbols });
      } catch (err) {
        logger.error({ err: err.message }, '获取币种列表失败');
        return sendJson(res, 500, { error: err.message });
      }
    }
    
    // 1.3 获取告警统计
    if (req.method === 'GET' && pathname === '/api/alerts/stats') {
      try {
        const q = parseQuery(req.url);
        const hours = q.hours ? Number(q.hours) : 24;
        const bySymbol = getAlertsStatsBySymbol(hours);
        logger.info({ hours, symbols: Object.keys(bySymbol).length }, '返回告警统计');
        return sendJson(res, 200, { bySymbol });
      } catch (err) {
        logger.error({ err: err.message }, '获取告警统计失败');
        return sendJson(res, 500, { error: err.message });
      }
    }
    
    // 1.4 获取单个币种的告警历史
    if (req.method === 'GET' && pathname.startsWith('/api/alerts/symbol/')) {
      try {
        const symbol = pathname.split('/').pop();
        const q = parseQuery(req.url);
        const hours = q.hours ? Number(q.hours) : 24;
        const alerts = getSymbolAlerts(symbol, hours);
        logger.info({ symbol, hours, count: alerts.length }, '返回币种告警历史');
        return sendJson(res, 200, { alerts });
      } catch (err) {
        logger.error({ err: err.message }, '获取币种告警历史失败');
        return sendJson(res, 500, { error: err.message });
      }
    }
    
    // 2. 最新市场状态
    if (req.method === 'GET' && pathname === '/market/state/latest') {
      const row = getLatestMarketState();
      logger.info({ hit: row ? 1 : 0 }, 'latest 查询完成');
      return sendJson(res, 200, { data: row });
    }
    if (req.method === 'GET' && pathname === '/market/state/history') {
      const q = parseQuery(req.url);
      const from = q.from !== undefined ? Number(q.from) : undefined;
      const to = q.to !== undefined ? Number(q.to) : undefined;
      const limit = q.limit ? Number(q.limit) : 1000;
      if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
        return sendJson(res, 400, { error: 'invalid_timestamp' });
      }
      const rows = getMarketStateHistory(from, to, limit);
      logger.info({ from, to, limit, rows: rows.length }, 'history 查询完成');
      return sendJson(res, 200, { data: rows });
    }
    if (req.method === 'GET' && pathname === '/market/state/details') {
      const q = parseQuery(req.url);
      const ts = q.ts !== undefined ? Number(q.ts) : undefined;
      if (!Number.isFinite(ts)) return sendJson(res, 400, { error: 'missing_or_invalid_ts' });
      const rows = getMarketStateDetails(ts);
      logger.info({ ts, rows: rows.length }, 'details 查询完成');
      return sendJson(res, 200, { data: rows });
    }
    
    // 移动平均线接口
    if (req.method === 'GET' && pathname === '/market/state/ma') {
      const q = parseQuery(req.url);
      const window = q.window ? Number(q.window) : 5; // 默认5分钟
      const from = q.from !== undefined ? Number(q.from) : undefined;
      const to = q.to !== undefined ? Number(q.to) : undefined;
      
      if (!Number.isFinite(window) || window <= 0) {
        return sendJson(res, 400, { error: 'invalid_window' });
      }
      if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
        return sendJson(res, 400, { error: 'invalid_timestamp' });
      }
      
      const rows = calculateMovingAverage(window, from, to);
      logger.info({ window, from, to, rows: rows.length }, 'MA 查询完成');
      return sendJson(res, 200, { data: rows, window });
    }
    
    // Market Volume Score 2 接口
    if (req.method === 'GET' && pathname === '/market/volume_score/latest') {
      const row = getLatestMarketVolumeScore();
      logger.info({ hit: row ? 1 : 0 }, 'volume_score latest 查询完成');
      return sendJson(res, 200, { data: row });
    }
    
    if (req.method === 'GET' && pathname === '/market/volume_score/history') {
      const q = parseQuery(req.url);
      const from = q.from !== undefined ? Number(q.from) : undefined;
      const to = q.to !== undefined ? Number(q.to) : undefined;
      const limit = q.limit ? Number(q.limit) : 1000;
      if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
        return sendJson(res, 400, { error: 'invalid_timestamp' });
      }
      const rows = getMarketVolumeScoreHistory(from, to, limit);
      logger.info({ from, to, limit, rows: rows.length }, 'volume_score history 查询完成');
      return sendJson(res, 200, { data: rows });
    }
    
    // ========== TradingView UDF 接口 ==========
    
    // 1. 配置接口
    if (req.method === 'GET' && pathname === '/tradingview/config') {
      return sendJson(res, 200, {
        supported_resolutions: ['1', '5', '15', '60', '240', 'D'],
        supports_group_request: false,
        supports_marks: false,
        supports_search: true,
        supports_timescale_marks: false
      });
    }
    
    // 2. 商品搜索接口
    if (req.method === 'GET' && pathname === '/tradingview/search') {
      const q = parseQuery(req.url);
      const query = (q.query || '').toLowerCase();
      const symbols = [
        {
          symbol: 'MARKET_PRICE',
          full_name: 'Market Price Score',
          description: '市场价格得分 (-100 ~ 100)',
          exchange: 'FUTURE_MONITOR',
          type: 'index'
        },
        {
          symbol: 'MARKET_VOLUME',
          full_name: 'Market Volume Score',
          description: '市场成交量得分 (0 ~ 100)',
          exchange: 'FUTURE_MONITOR',
          type: 'index'
        }
      ];
      const filtered = query ? symbols.filter(s => 
        s.symbol.toLowerCase().includes(query) || 
        s.description.toLowerCase().includes(query)
      ) : symbols;
      return sendJson(res, 200, filtered);
    }
    
    // 3. 商品信息接口
    if (req.method === 'GET' && pathname === '/tradingview/symbols') {
      const q = parseQuery(req.url);
      const symbol = q.symbol;
      
      if (symbol === 'MARKET_PRICE') {
        return sendJson(res, 200, {
          name: 'MARKET_PRICE',
          ticker: 'MARKET_PRICE',
          description: '市场价格得分',
          type: 'index',
          session: '24x7',
          exchange: 'FUTURE_MONITOR',
          listed_exchange: 'FUTURE_MONITOR',
          timezone: 'Etc/UTC',
          minmov: 1,
          pricescale: 100,
          has_intraday: true,
          supported_resolutions: ['1', '5', '15', '60', '240', 'D'],
          data_status: 'streaming'
        });
      }
      
      if (symbol === 'MARKET_VOLUME') {
        return sendJson(res, 200, {
          name: 'MARKET_VOLUME',
          ticker: 'MARKET_VOLUME',
          description: '市场成交量得分',
          type: 'index',
          session: '24x7',
          exchange: 'FUTURE_MONITOR',
          listed_exchange: 'FUTURE_MONITOR',
          timezone: 'Etc/UTC',
          minmov: 1,
          pricescale: 100,
          has_intraday: true,
          supported_resolutions: ['1', '5', '15', '60', '240', 'D'],
          data_status: 'streaming'
        });
      }
      
      return sendJson(res, 404, { s: 'error', errmsg: 'Symbol not found' });
    }
    
    // 4. 历史数据接口（K线数据）
    if (req.method === 'GET' && pathname === '/tradingview/history') {
      try {
        const q = parseQuery(req.url);
        const symbol = q.symbol;
        const resolution = q.resolution || '1';
        const from = Number(q.from) * 1000; // TradingView 使用秒，转换为毫秒
        const to = Number(q.to) * 1000;
        
        logger.debug({ symbol, resolution, from, to }, 'TradingView history 请求');
        
        if (!symbol || !RESOLUTION_MAP[resolution]) {
          logger.warn({ symbol, resolution }, 'Invalid parameters');
          return sendJson(res, 400, { s: 'error', errmsg: 'Invalid parameters' });
        }
        
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          logger.warn({ from, to }, 'Invalid timestamp');
          return sendJson(res, 400, { s: 'error', errmsg: 'Invalid timestamp' });
        }
        
        // 查询原始分钟数据
        const rows = getMarketStateHistory(from, to, 10000);
        
        logger.debug({ rowCount: rows ? rows.length : 0 }, '查询到原始数据');
        
        if (!rows || rows.length === 0) {
          logger.info({ symbol, from, to }, 'No data found');
          return sendJson(res, 200, { s: 'no_data', nextTime: Math.floor(to / 1000) });
        }
        
        // 根据分辨率聚合数据
        const resolutionMs = RESOLUTION_MAP[resolution];
        const aggregated = aggregateToResolution(rows, resolutionMs);
        
        if (aggregated.length === 0) {
          logger.warn({ symbol, resolution }, 'Aggregation returned empty');
          return sendJson(res, 200, { s: 'no_data', nextTime: Math.floor(to / 1000) });
        }
        
        // 转换为 TradingView 格式
        const t = []; // 时间戳（秒）
        const o = []; // 开盘价
        const h = []; // 最高价
        const l = []; // 最低价
        const c = []; // 收盘价
        const v = []; // 成交量（这里用 volume_score）
        
        for (const bar of aggregated) {
          if (!bar || typeof bar.time !== 'number') continue;
          
          const value = symbol === 'MARKET_PRICE' ? {
            open: bar.open_price,
            high: bar.high_price,
            low: bar.low_price,
            close: bar.close_price
          } : {
            open: bar.open_volume,
            high: bar.high_volume,
            low: bar.low_volume,
            close: bar.close_volume
          };
          
          // 检查值是否有效
          if (typeof value.open !== 'number' || typeof value.close !== 'number') continue;
          
          t.push(Math.floor(bar.time / 1000));
          o.push(value.open);
          h.push(value.high);
          l.push(value.low);
          c.push(value.close);
          v.push(bar.count); // 使用聚合的数据点数量作为成交量
        }
        
        logger.info({ symbol, resolution, from, to, bars: t.length }, 'TradingView history 查询完成');
        
        return sendJson(res, 200, {
          s: 'ok',
          t,
          o,
          h,
          l,
          c,
          v
        });
      } catch (err) {
        logger.error({ err: err.message, stack: err.stack }, 'TradingView history error');
        return sendJson(res, 500, { s: 'error', errmsg: err.message });
      }
    }
    
    return notFound(res);
  } catch (e) {
    logger.error({ err: String(e) }, 'server error');
    return sendJson(res, 500, { error: 'server_error', message: String(e) });
  }
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'HTTP 服务已启动');
});
