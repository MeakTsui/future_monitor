import fs from "fs";
import fetch from "node-fetch";
import logger from "./logger.js";
import { getAllSuppliesMap, getAlertState as dbGetAlertState, setAlertState as dbSetAlertState } from "./db.js";

const CONFIG_FILE = "./config.json";
// 已迁移到 SQLite，移除本地 JSON 文件依赖

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// 将旧的 detailsText（如 "lastVol=123.45, MA=67.89, x=1.82"）美化为更友好的展示
function beautifyDetailsText(detailsText) {
    if (!detailsText || typeof detailsText !== 'string') return '';
    try {
        const parts = detailsText.split(',').map(s => s.trim()).filter(Boolean);
        const map = {};
        for (const p of parts) {
            const [kRaw, vRaw] = p.split('=').map(s => s && s.trim());
            if (!kRaw) continue;
            map[kRaw] = vRaw;
        }
        const lineParts = [];
        // 优先展示 USD 成交额和市值（若存在）
        if (map.volumeUsd !== undefined) {
            const n = parseFloat(map.volumeUsd);
            lineParts.push(`成交额(USD)=${Number.isFinite(n) ? formatCurrencyCompact(n) : map.volumeUsd}`);
        }
        if (map.maUsd !== undefined) {
            const n = parseFloat(map.maUsd);
            lineParts.push(`MA额(USD)=${Number.isFinite(n) ? formatCurrencyCompact(n) : map.maUsd}`);
        }
        if (map.marketCap !== undefined) {
            const n = parseFloat(map.marketCap);
            lineParts.push(`市值=${Number.isFinite(n) ? formatCurrencyCompact(n) : map.marketCap}`);
        }
        // 兼容旧键
        if (map.x !== undefined) {
            const n = parseFloat(map.x);
            lineParts.push(`倍数 x=${Number.isFinite(n) ? formatNumber(n) : map.x}`);
        }
        if (map.lastVol !== undefined) {
            const n = parseFloat(map.lastVol);
            lineParts.push(`成交量=${Number.isFinite(n) ? formatNumber(n) : map.lastVol}`);
        }
        if (map.MA !== undefined) {
            const n = parseFloat(map.MA);
            lineParts.push(`MA=${Number.isFinite(n) ? formatNumber(n) : map.MA}`);
        }
        return lineParts.join(' | ') || detailsText;
    } catch {
        return detailsText;
    }
}

function loadSupplyMap() {
    // 从 SQLite 读取全部 supplies，返回 symbol -> entry 的映射
    return getAllSuppliesMap();
}

async function fetchBinanceFuturesSymbols() {
    const url = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const resp = await fetch(url);
    const data = await resp.json();
    return data.symbols
        .filter((s) => s.contractType === "PERPETUAL")
        .map((s) => s.symbol);
}

async function fetchKline(symbol, interval = "15m", limit = 7) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const resp = await fetch(url);
    let data;
    try {
        data = await resp.json();
    } catch (e) {
        logger.warn({ symbol, err: e.message }, `[${new Date().toISOString()}] 解析 K 线响应失败`);
        return null;
    }
    // Binance 在无效交易对/限流时会返回对象而非数组
    if (!resp.ok || !Array.isArray(data)) return null;
    return data;
}

// ========== Alert Providers ==========

async function sendConsole(message, providerConfig) {
    logger.info(message);
}

async function sendTelegram(message, providerConfig) {
    const url = `https://api.telegram.org/bot${providerConfig.botToken}/sendMessage`;
    const body = {
        chat_id: providerConfig.chatId,
        text: message,
        // 使用 Markdown 以支持 [text](url) 链接
        parse_mode: "Markdown",
        disable_web_page_preview: true
    };

    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const result = await resp.json();
        if (!result.ok) {
            console.error("发送 Telegram 失败:", result);
        }
    } catch (err) {
        console.error("发送 Telegram 出错:", err.message);
    }
}

async function sendWebhook(message, providerConfig) {
    try {
        const resp = await fetch(providerConfig.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: message }),
        });
        if (!resp.ok) {
            console.error("Webhook 推送失败:", await resp.text());
        }
    } catch (err) {
        console.error("Webhook 推送出错:", err.message);
    }
}

const providers = {
    console: sendConsole,
    telegram: sendTelegram,
    webhook: sendWebhook
};

// ========== Alert helpers: 状态管理、冷却与同K线去重 ==========
function makeAlertKey(symbol, reason) {
    return `${symbol}|${reason}`;
}

function shouldAlert(symbol, reason, closeTime, cooldownSec) {
    const key = makeAlertKey(symbol, reason);
    const row = dbGetAlertState(key);
    const now = Date.now();
    if (row) {
        if (row.last_kline_close === closeTime) {
            return { ok: false, reason: "same_kline", remainingSec: 0 };
        }
        if (row.last_at && now - row.last_at < cooldownSec * 1000) {
            const remainingMs = row.last_at + cooldownSec * 1000 - now;
            return { ok: false, reason: "cooldown", remainingSec: Math.ceil(remainingMs / 1000) };
        }
    }
    return { ok: true, reason: null, remainingSec: 0 };
}

function markAlertSent(symbol, reason, closeTime) {
    const key = makeAlertKey(symbol, reason);
    dbSetAlertState(key, Date.now(), closeTime);
}

async function alert(symbol, reason, data, config) {
    const msg = buildNiceAlertMessage(symbol, reason, data);

    for (const provider of config.alerts) {
        const sender = providers[provider.provider];
        if (sender) {
            await sender(msg, provider);
        } else {
            logger.warn({ provider }, "未知的 provider");
        }
    }
}

async function alertBatch(title, items, config) {
    // items: Array<{ symbol, lastVol?, ma?, ratio?, volumeUsd?, maUsd?, marketCap?, prevClose?, closePrice?, deltaPct?, trendEmoji?, detailsText? }>
    if (!items || items.length === 0) return;

    const header = `*ALERT* [批量] ${title}（共 ${items.length} 条）`;
    const blocks = items.map(i => {
        const link = `[${i.symbol}](${buildBinanceFuturesUrl(i.symbol)})`;
        const lines = [];
        // 首行：趋势图标 + 合约链接
        lines.push(`${i.trendEmoji || ''} ${link}`.trim());
        // 逐行展示关键字段
        if (typeof i.volumeUsd === 'number' && !Number.isNaN(i.volumeUsd)) {
            lines.push(`- 成交额(USD): ${formatCurrencyCompact(i.volumeUsd)}`);
        }
        if (typeof i.maUsd === 'number' && !Number.isNaN(i.maUsd)) {
            lines.push(`- MA额(USD): ${formatCurrencyCompact(i.maUsd)}`);
        }
        if (typeof i.marketCap === 'number' && !Number.isNaN(i.marketCap)) {
            lines.push(`- 市值: ${formatCurrencyCompact(i.marketCap)}`);
        }
        if (typeof i.ratio === 'number' && !Number.isNaN(i.ratio)) {
            // 倍数去掉 x=
            lines.push(`- 倍数: ${formatNumber(i.ratio)}`);
        }
        if (typeof i.prevClose === 'number' && typeof i.closePrice === 'number' &&
            !Number.isNaN(i.prevClose) && !Number.isNaN(i.closePrice)) {
            const pctText = (typeof i.deltaPct === 'number' && !Number.isNaN(i.deltaPct))
              ? ` (${i.deltaPct >= 0 ? '+' : ''}${formatNumber(i.deltaPct * 100)}%)`
              : '';
            lines.push(`- 价格: ${formatCurrency(i.prevClose)} → ${formatCurrency(i.closePrice)}${pctText}`);
        }
        // 若无可展示的结构化字段，回退到 detailsText 的美化
        if (lines.length <= 1) {
            const fallback = i.detailsText ? beautifyDetailsText(i.detailsText) : '';
            if (fallback) lines.push(`- ${fallback}`);
        }
        return lines.join('\n');
    });

    // 币种间使用分隔线
    let body = blocks.join('\n-------\n');
    let msg = `${header}\n${body}`;
    if (msg.length > 3500) { // 留余量，避免 Telegram 4096 限制
        const allowed = 3400 - header.length;
        body = body.slice(0, Math.max(0, allowed));
        msg = `${header}\n${body}\n... 已截断，原共 ${items.length} 条`;
    }

    for (const provider of config.alerts) {
        const sender = providers[provider.provider];
        if (sender) {
            await sender(msg, provider);
        } else {
            logger.warn({ provider }, "未知的 provider");
        }
    }
}
// =============================================================

// ========== Symbol helpers: 从合约符号映射到 supply.json 的 symbol ==========
function buildBinanceFuturesUrl(contractSymbol) {
    // 直接跳转 USDT 永续合约页面
    // Binance 会根据设备/客户端引导打开 App
    return `https://www.binance.com/en/futures/${contractSymbol}`;
}
function normalizeBaseSymbolFromContract(sym) {
    // 输入示例：ETHUSDT, 1000SHIBUSDT, BNBUPUSDT, XRPBULLUSDT
    let base = sym;
    // 去稳定币后缀
    base = base.replace(/(USDT|BUSD|USDC)$/i, "");
    // 去杠杆方向后缀（部分合约）
    base = base.replace(/(UP|DOWN|BULL|BEAR)$/i, "");
    // 去 1000 等前缀
    base = base.replace(/^(\d{3,})/, "");
    return base.toUpperCase();
}

// ========== Message formatting helpers ==========
function formatNumber(n, digits = 2) {
    if (typeof n !== 'number' || isNaN(n)) return String(n);
    return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatCurrency(n, digits = 2) {
    if (typeof n !== 'number' || isNaN(n)) return String(n);
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// 紧凑金额显示：$12.34K / $5.67M / $8.90B / $1.23T，保留两位小数
function formatCurrencyCompact(n, digits = 2) {
    if (typeof n !== 'number' || isNaN(n)) return String(n);
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const fmt = (v, suffix = '') => `${sign}$${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
    if (abs >= 1e12) return fmt(abs / 1e12, 'T');
    if (abs >= 1e9) return fmt(abs / 1e9, 'B');
    if (abs >= 1e6) return fmt(abs / 1e6, 'M');
    if (abs >= 1e3) return fmt(abs / 1e3, 'K');
    return fmt(abs, '');
}

function buildNiceAlertMessage(symbol, reason, data = {}) {
    const link = `[${symbol}](${buildBinanceFuturesUrl(symbol)})`;
    const parts = [];
    const emoji = data.trendEmoji || '';
    parts.push(`‼️‼️${link} ${emoji}`);
    parts.push(`*原因*: ${reason}`);
    // 针对已知字段做友好展示
    if (data.matchedBase) parts.push(`*基础币*: ${data.matchedBase}`);
    if (typeof data.lastVol === 'number') parts.push(`*成交量*: ${formatNumber(data.lastVol)}`);
    if (typeof data.ma === 'number') parts.push(`*MA*: ${formatNumber(data.ma)}`);
    if (typeof data.volumeUsd === 'number') parts.push(`*成交量(USD)*: ${formatCurrencyCompact(data.volumeUsd)}`);
    if (typeof data.marketCap === 'number') parts.push(`*市值*: ${formatCurrencyCompact(data.marketCap)}`);
    if (typeof data.ratio === 'number') parts.push(`*倍数*: ${formatNumber(data.ratio)}`);
    // 价格变化（更美观）：$prev → $close (±pct%) + 表情
    if (typeof data.prevClose === 'number' && typeof data.closePrice === 'number') {
        const pct = typeof data.deltaPct === 'number' ? `${data.deltaPct >= 0 ? '+' : ''}${formatNumber(data.deltaPct * 100)}%` : '';
        parts.push(`*价格*: ${formatCurrency(data.prevClose)} → ${formatCurrency(data.closePrice)} (${pct}) ${emoji}`);
    }
    // 其他字段以 key: value 形式追加（过滤已展示的键）
    const shown = new Set(['matchedBase','lastVol','ma','volumeUsd','marketCap','ratio','trendEmoji','prevClose','closePrice','deltaPct']);
    Object.keys(data || {}).forEach(k => {
        if (shown.has(k)) return;
        const v = data[k];
        parts.push(`*${k}*: ${typeof v === 'number' ? formatNumber(v) : String(v)}`);
    });
    return parts.join('\n');
}

function findSupplyForSymbol(supplyData, contractSymbol) {
    if (!supplyData) return null;
    const keys = supplyData; // 对象：symbol(大写) -> data
    const candidates = [];
    const direct = normalizeBaseSymbolFromContract(contractSymbol);
    candidates.push(direct);
    // 如果有 1000 前缀被去掉后的再尝试一遍（已在 normalize 中处理，这里冗余保留）
    if (/^1000/i.test(contractSymbol)) {
        const no1000 = contractSymbol.replace(/^1000/i, "");
        candidates.push(normalizeBaseSymbolFromContract(no1000));
    }
    // 有些币在 Binance 符号与 CoinGecko 符号存在少量差异，可在此加入人工别名表
    const aliasMap = {
        // 示例："IOTA": "MIOTA" // 若需要可开启
    };
    if (aliasMap[direct]) candidates.push(aliasMap[direct]);

    for (const c of candidates) {
        if (keys[c]) return { key: c, supply: keys[c] };
    }
    return null;
}
// =============================================================

async function monitor(config) {
    const supplyData = loadSupplyMap();
    const symbols = await fetchBinanceFuturesSymbols();

    const cooldownSec = typeof config.alertCooldownSec === "number" ? config.alertCooldownSec : 1800;
    // 去重状态改由 SQLite 持久化

    const supplyCount = supplyData ? Object.keys(supplyData).length : 0;
    logger.info({ symbols: symbols.length, cooldownSec, supplyCount, klineInterval: config.klineInterval, maWindow: config.maWindow }, "开始监控");
    const rule2Enabled = supplyCount >= 100; // 供给数据过少时暂时禁用规则2，避免噪声
    if (!rule2Enabled) {
        logger.warn({ supplyCount }, "当前 supply 数据较少，本轮暂时跳过规则2（市值相关）以避免误报");
    }

    const rule1Hits = []; // 汇总规则1
    let missingSupplyCount = 0;
    const missingSupplyExamples = [];

    for (const sym of symbols) {
        try {
            const klines = await fetchKline(sym, config.klineInterval, config.maWindow);
            if (!Array.isArray(klines)) {
                logger.debug({ symbol: sym }, "跳过: K 线返回非数组（可能无效交易对/限流）");
                continue;
            }
            if (klines.length < config.maWindow) {
                logger.debug({ symbol: sym, have: klines.length, need: config.maWindow }, "跳过: K 线数量不足");
                continue;
            }

            const vols = klines.map((k) => parseFloat(k[5]));
            const ma = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
            const lastVol = vols[vols.length - 1];
            const lastK = klines[klines.length - 1];
            const prevK = klines[klines.length - 2];
            const closePrice = parseFloat(lastK[4]);
            const prevClose = parseFloat(prevK[4]);
            const closeTime = parseInt(lastK[6]); // Binance: 索引6为收盘时间戳(ms)
            const deltaPct = (prevClose > 0) ? (closePrice - prevClose) / prevClose : 0;
            const trendEmoji = deltaPct > 0 ? '📈' : (deltaPct < 0 ? '📉' : '➖');
            logger.debug({ symbol: sym, lastVol, ma, closePrice, prevClose, deltaPct, closeTime }, "K线计算完成");

            // 规则1: 成交量突破 MA（合并汇总）
            if (ma > 0 && lastVol >= ma * config.maVolumeMultiplier) {
                const reason1 = "成交量突破 MA";
                const check1 = shouldAlert(sym, reason1, closeTime, cooldownSec);
                if (check1.ok) {
                    const ratio = ma > 0 ? (lastVol / ma) : 0;
                    // 计算以 USD 计价的成交额与 MA 成交额
                    const volumeUsd = (typeof lastVol === 'number' && typeof closePrice === 'number') ? lastVol * closePrice : undefined;
                    const maUsd = (typeof ma === 'number' && typeof closePrice === 'number') ? ma * closePrice : undefined;
                    // 计算市值（若能匹配到 supply）
                    let marketCap;
                    try {
                        const sf = findSupplyForSymbol(supplyData, sym);
                        if (sf && sf.supply && typeof sf.supply.circulating_supply === 'number') {
                            marketCap = closePrice * sf.supply.circulating_supply;
                        }
                    } catch {}
                    rule1Hits.push({
                        symbol: sym,
                        // 保留结构化数值，便于批量美化展示
                        lastVol,
                        ma,
                        ratio,
                        deltaPct,
                        trendEmoji,
                        prevClose,
                        closePrice,
                        volumeUsd,
                        maUsd,
                        marketCap,
                        // 兼容字段：作为后备显示（改为放入 USD 与市值，避免退化成手数/张数）
                        detailsText: `volumeUsd=${(volumeUsd ?? 0).toFixed(2)}, maUsd=${(maUsd ?? 0).toFixed(2)}, marketCap=${(marketCap ?? 0).toFixed(2)}, x=${ratio.toFixed(2)}`,
                        closeTime,
                        reason: reason1,
                    });
                    logger.debug({ symbol: sym, lastVol, ma }, "规则1命中（加入批量队列）");
                } else {
                    logger.debug({ symbol: sym, reason: check1.reason, remainingSec: check1.remainingSec }, "规则1抑制");
                }
            }

            // 规则2: 成交量 >= 市值 * 阈值（即时发送）
            if (rule2Enabled) {
                const supplyFound = findSupplyForSymbol(supplyData, sym);
                if (supplyFound && supplyFound.supply && supplyFound.supply.circulating_supply) {
                    const marketCap = closePrice * supplyFound.supply.circulating_supply;
                    const volumeUsd = lastVol * closePrice;
                    const vmMultiple = marketCap > 0 ? (volumeUsd / marketCap) : 0;
                    if (volumeUsd >= config.volumeToMarketcapRatio * marketCap) {
                        const reason2 = `15m成交量达到市值${config.volumeToMarketcapRatio}倍`;
                        const check2 = shouldAlert(sym, reason2, closeTime, cooldownSec);
                        if (check2.ok) {
                            await alert(sym, reason2, { volumeUsd, marketCap, ratio: vmMultiple, deltaPct, trendEmoji, prevClose, closePrice }, config);
                            markAlertSent(sym, reason2, closeTime);
                            logger.info({ symbol: sym, base: supplyFound.key, volumeUsd, marketCap }, "规则2发送");
                        } else {
                            logger.debug({ symbol: sym, reason: check2.reason, remainingSec: check2.remainingSec }, "规则2抑制");
                        }
                    }
                } else {
                    missingSupplyCount++;
                    if (missingSupplyExamples.length < 10) {
                        const baseTried = normalizeBaseSymbolFromContract(sym);
                        missingSupplyExamples.push(`${sym}(${baseTried})`);
                    }
                }
            }
        } catch (err) {
            logger.error({ symbol: sym, err: err.message }, "监控出错");
        }

        await new Promise((res) => setTimeout(res, 200)); // 控制速率
    }

    // 合并发送规则1
    if (rule1Hits.length > 0) {
        await alertBatch(`${config.klineInterval}成交量突破 MA(${config.maWindow}) ${config.maVolumeMultiplier}倍`, rule1Hits, config);
        // 发送成功后，统一标记状态
        for (const h of rule1Hits) {
            markAlertSent(h.symbol, h.reason, h.closeTime);
        }
        logger.info({ count: rule1Hits.length }, "规则1批量发送完成");
    } else {
        logger.debug("本轮无规则1批量告警需要发送");
    }

    if (rule2Enabled) {
        if (missingSupplyCount > 0) {
            logger.warn({ missingSupplyCount, examples: missingSupplyExamples }, "本轮规则2跳过若干交易对（缺少 supply）");
        }
    } else {
        logger.warn("本轮规则2已禁用（supply 数据量过低）");
    }
}

async function main() {
    const config = loadConfig();
    // 允许通过配置覆盖日志级别
    if (config.logLevel) {
        try {
            logger.level = config.logLevel;
            logger.info({ level: logger.level }, "日志级别由配置覆盖");
        } catch (e) {
            logger.warn({ level: config.logLevel }, "无效的日志级别，已忽略");
        }
    }
    const interval = config.monitorIntervalSec * 1000;

    while (true) {
        logger.info("开始新一轮监控");
        await monitor(config);
        await new Promise((res) => setTimeout(res, interval));
    }
}

main();