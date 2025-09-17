import fs from "fs";
import fetch from "node-fetch";

const CONFIG_FILE = "./config.json";
const SUPPLY_FILE = "./supply.json";

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function loadExistingSupply() {
    try {
        if (fs.existsSync(SUPPLY_FILE)) {
            const raw = fs.readFileSync(SUPPLY_FILE, "utf8");
            if (raw && raw.trim()) {
                return JSON.parse(raw);
            }
        }
    } catch (e) {
        console.warn("读取现有 supply.json 失败，将从空数据开始:", e.message);
    }
    return {
        last_sync: null,
        data: {},
        current_sync: {
            started_at: null,
            last_page: 0,
            completed: true,
        },
    };
}

function saveSupplyIncremental(state) {
    fs.writeFileSync(
        SUPPLY_FILE,
        JSON.stringify(state, null, 2)
    );
}

async function fetchWithRetry(url, { maxRetries = 5, initialDelayMs = 1500 } = {}) {
    let attempt = 0;
    let delay = initialDelayMs;
    while (true) {
        try {
            const resp = await fetch(url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "future_monitor/1.0 (+https://coingecko.com; contact: script)"
                },
            });
            if (resp.status === 429) {
                // 速率限制，退避重试
                const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
                const waitMs = Math.max(delay, (isNaN(retryAfter) ? 0 : retryAfter * 1000));
                await new Promise(r => setTimeout(r, waitMs));
                attempt++;
                delay = Math.min(delay * 2, 20000);
                if (attempt > maxRetries) {
                    throw new Error(`429 Too Many Requests，已重试 ${maxRetries} 次仍失败`);
                }
                continue;
            }
            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                throw new Error(`HTTP ${resp.status} ${resp.statusText} - ${text}`);
            }
            return await resp.json();
        } catch (err) {
            attempt++;
            if (attempt > maxRetries) throw err;
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 2, 20000);
        }
    }
}

async function fetchSupply() {
    const perPage = 250; // CoinGecko 限制 per_page 最大为 250
    const state = loadExistingSupply();

    // 判断是否续传
    const continuing = state.current_sync && state.current_sync.completed === false;
    if (!continuing) {
        state.current_sync = {
            started_at: new Date().toISOString(),
            last_page: 0,
            completed: false,
        };
        // 新一轮同步从空开始（也可以选择以 symbol 合并旧数据，这里按需求重刷）
        state.data = {};
        saveSupplyIncremental(state);
    }

    let page = (state.current_sync.last_page || 0) + 1;

    while (true) {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
        const data = await fetchWithRetry(url);

        if (!data || data.length === 0) {
            // 标记完成
            state.current_sync.completed = true;
            state.last_sync = new Date().toISOString();
            saveSupplyIncremental(state);
            break;
        }

        for (const coin of data) {
            const symbol = (coin.symbol || "").toUpperCase();
            if (!symbol) continue;
            state.data[symbol] = {
                id: coin.id,
                symbol,
                name: coin.name,
                circulating_supply: coin.circulating_supply,
                last_updated: coin.last_updated,
            };
        }

        // 记录进度并增量写入
        state.current_sync.last_page = page;
        saveSupplyIncremental(state);

        page++;
        // 友好延时，降低触发限流概率
        await new Promise((res) => setTimeout(res, 1500));
    }

    console.log(`[${new Date().toISOString()}] 已同步 ${Object.keys(state.data).length} 个币种的 supply 数据`);
}

async function main() {
    const config = loadConfig();
    const interval = config.supplySyncIntervalSec * 1000;

    while (true) {
        try {
            await fetchSupply();
        } catch (err) {
            console.error("同步出错:", err.message);
        }
        await new Promise((res) => setTimeout(res, interval));
    }
}

main();