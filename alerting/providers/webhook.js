import fetch from "node-fetch";
import logger from "../../logger.js";

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function interpolateString(tpl, ctx) {
  if (typeof tpl !== 'string') return tpl;
  return tpl.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const v = getByPath(ctx, expr.trim());
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function interpolateTemplate(tpl, ctx) {
  if (tpl === null || tpl === undefined) return tpl;
  if (typeof tpl === 'string') return interpolateString(tpl, ctx);
  if (Array.isArray(tpl)) return tpl.map((x) => interpolateTemplate(x, ctx));
  if (typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = interpolateTemplate(v, ctx);
    return out;
  }
  return tpl;
}

export default async function sendWebhook({ text, payload, providerConfig, context = {} }) {
  if (!providerConfig?.url && !providerConfig?.module) {
    logger.warn({ providerConfig }, "Webhook 配置缺失，跳过发送");
    return;
  }

  // 高级：外部模块自定义请求构建
  if (providerConfig && providerConfig.module) {
    try {
      const mod = await import(providerConfig.module);
      const buildRequest = mod.default || mod.buildRequest || mod.send;
      if (typeof buildRequest !== 'function') {
        logger.warn({ module: providerConfig.module }, 'Webhook 自定义模块未导出函数');
      } else {
        const req = await buildRequest({ text, payload, providerConfig, context });
        const resp = await fetch(req.url, {
          method: req.method || 'POST',
          headers: req.headers || { 'Content-Type': 'application/json' },
          body: req.body,
        });
        if (!resp.ok) {
          logger.error({ status: resp.status, text: await resp.text() }, "Webhook 推送失败");
        }
        return;
      }
    } catch (e) {
      logger.error({ err: e.message }, '加载 Webhook 自定义模块失败');
    }
  }

  // 模板化构建 body
  const {
    method = 'POST',
    headers = { 'Content-Type': 'application/json' },
    query,
    bodyMode = 'json',
    bodyTemplate,
    rawBodyTemplate,
    includeText = true,
    includePayload = true,
    textKey = 'text',
    payloadKey = 'payload',
  } = providerConfig || {};

  let url = providerConfig.url;
  if (query && typeof query === 'object') {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      const sv = interpolateString(String(v), { text, payload, context });
      sp.append(k, sv);
    }
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}${sp.toString()}`;
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const baseCtx = { text, payload, context };
    if (bodyMode === 'raw') {
      const raw = rawBodyTemplate ? interpolateString(rawBodyTemplate, baseCtx) : (includeText ? text : '');
      body = raw;
    } else if (bodyMode === 'form') {
      const form = new URLSearchParams();
      if (includeText) form.append(textKey, text);
      if (includePayload) form.append(payloadKey, JSON.stringify(payload));
      if (bodyTemplate && typeof bodyTemplate === 'object') {
        const t = interpolateTemplate(bodyTemplate, baseCtx);
        for (const [k, v] of Object.entries(t)) form.append(k, String(v));
      }
      body = form.toString();
    } else { // json
      const obj = {};
      if (includeText) obj[textKey] = text;
      if (includePayload) obj[payloadKey] = payload;
      if (bodyTemplate && typeof bodyTemplate === 'object') {
        const t = interpolateTemplate(bodyTemplate, baseCtx);
        Object.assign(obj, t);
      }
      body = JSON.stringify(obj);
    }
  }
  try {
    const resp = await fetch(url, { method, headers, body });
    if (!resp.ok) {
      logger.error({ status: resp.status, text: await resp.text() }, "Webhook 推送失败");
    }
  } catch (err) {
    logger.error({ err: err.message }, "Webhook 推送出错");
  }
}
