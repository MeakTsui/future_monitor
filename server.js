import http from 'http';
import url from 'url';
import logger from './logger.js';
import { getLatestMarketState, getMarketStateHistory, getMarketStateDetails } from './db.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFound(res) { sendJson(res, 404, { error: 'not_found' }); }

function parseQuery(reqUrl) { return url.parse(reqUrl, true).query || {}; }

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const path = parsed.pathname || '/';
    logger.debug({ method: req.method, path, query: parsed.query }, '收到 HTTP 请求');
    if (req.method === 'GET' && path === '/market/state/latest') {
      const row = getLatestMarketState();
      logger.info({ hit: row ? 1 : 0 }, 'latest 查询完成');
      return sendJson(res, 200, { data: row });
    }
    if (req.method === 'GET' && path === '/market/state/history') {
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
    if (req.method === 'GET' && path === '/market/state/details') {
      const q = parseQuery(req.url);
      const ts = q.ts !== undefined ? Number(q.ts) : undefined;
      if (!Number.isFinite(ts)) return sendJson(res, 400, { error: 'missing_or_invalid_ts' });
      const rows = getMarketStateDetails(ts);
      logger.info({ ts, rows: rows.length }, 'details 查询完成');
      return sendJson(res, 200, { data: rows });
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
