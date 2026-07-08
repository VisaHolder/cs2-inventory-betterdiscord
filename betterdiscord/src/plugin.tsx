/*
 * CS2Inventory — BetterDiscord edition
 * Copyright (c) 2026 VisaHolder
 * SPDX-License-Identifier: MIT
 *
 * CS2 inventory value on Discord profile popouts, with Doppler/Gamma phase
 * pricing (CSFloat), FX-converted prices, and a Trade Offer / Steam button row.
 */

import { FadeCalculator, AmberFadeCalculator, AcidFadeCalculator } from "csgo-fade-percentage-calculator";
import bluegemData from "./bluegem.json";

const BD: any = (window as any).BdApi;
const PLUGIN_NAME = "CS2Inventory";
const { Webpack } = BD;

// ── Discord internals via BetterDiscord's webpack ───────────────────────────
// Resolved defensively: a webpack lookup throwing (some Discord modules have
// getters that throw when a filter touches them) must never stop the plugin
// from loading. Anything that fails stays null and its feature degrades.
let UserStore: any, UserProfileStore: any, SelectedGuildStore: any, SelectedChannelStore: any, RestAPI: any, MessageActions: any;
try { UserStore = Webpack.getStore("UserStore"); } catch { /* */ }
try { UserProfileStore = Webpack.getStore("UserProfileStore"); } catch { /* */ }
try { SelectedGuildStore = Webpack.getStore("SelectedGuildStore"); } catch { /* */ }
try { SelectedChannelStore = Webpack.getStore("SelectedChannelStore"); } catch { /* */ }
try {
    RestAPI = (Webpack.getByKeys && Webpack.getByKeys("getAPIBaseURL", "get", "post"))
        || Webpack.getModule((m: any) => m?.getAPIBaseURL && typeof m?.get === "function" && typeof m?.post === "function");
} catch { /* */ }
try {
    MessageActions = (Webpack.getByKeys && Webpack.getByKeys("sendMessage", "editMessage"))
        || Webpack.getModule((m: any) => typeof m?.sendMessage === "function" && typeof m?.editMessage === "function");
} catch { /* */ }

// ── External HTTP. BdApi.Net.fetch is CSP-free (like Vencord's native helper),
//    so requests to steamcommunity.com / csfloat.com / etc. are not blocked. ──
async function fetchJson(url: string, opts?: { method?: string; body?: any; headers?: Record<string, string> }): Promise<any> {
    const bodyStr = opts?.body != null ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
    if (bodyStr) headers["Content-Type"] = "application/json";
    const res = await BD.Net.fetch(url, { method: opts?.method || "GET", headers, body: bodyStr });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
}

async function fetchText(url: string): Promise<string> {
    const res = await BD.Net.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
}

// ── Settings + snapshot storage backed by BdApi.Data (synchronous, file-backed) ──
const OptionType = { STRING: "STRING", NUMBER: "NUMBER", BOOLEAN: "BOOLEAN", SELECT: "SELECT" };
const loadSettings = (): Record<string, any> => BD.Data.load(PLUGIN_NAME, "settings") || {};
const settings = {
    store: new Proxy({} as Record<string, any>, {
        get: (_t, key: string) => {
            const all = loadSettings();
            if (key in all) return all[key];
            const def = (SETTINGS_SCHEMA as any)[key];
            if (!def) return undefined;
            // SELECT defaults live on the chosen OPTION (`default: true`), not the schema entry —
            // resolve them here so an unset dropdown reports its real default instead of undefined
            // (which silently fell through to per-call `|| fallback`s, e.g. the delta window → 1h).
            if (def.type === OptionType.SELECT) {
                const opt = (def.options || []).find((o: any) => o.default);
                return opt ? opt.value : def.options?.[0]?.value;
            }
            return def.default;
        },
        set: (_t, key: string, val: any) => {
            const all = loadSettings(); all[key] = val;
            BD.Data.save(PLUGIN_NAME, "settings", all);
            return true;
        },
    }),
};
const DataStore = {
    get: async (k: string) => BD.Data.load(PLUGIN_NAME, k),
    set: async (k: string, v: any) => { BD.Data.save(PLUGIN_NAME, k, v); },
};

// Per-user opt-in for the inventory card (inventoryMode = "enabled"). Toggled from the user
// right-click menu and persisted, so the card only appears for users you've turned it on for.
const ENABLED_USERS_KEY = "vsi.enabledUsers";
let enabledUsers = new Set<string>();
function loadEnabledUsers() { try { enabledUsers = new Set(BD.Data.load(PLUGIN_NAME, ENABLED_USERS_KEY) ?? []); } catch { enabledUsers = new Set(); } }
const isCardEnabled = (userId: string): boolean => enabledUsers.has(userId);
function setCardEnabled(userId: string, on: boolean) {
    if (on) enabledUsers.add(userId); else enabledUsers.delete(userId);
    try { BD.Data.save(PLUGIN_NAME, ENABLED_USERS_KEY, [...enabledUsers]); } catch { /* */ }
}

interface SteamProfile { steamId: string; persona?: string; avatar?: string }

async function resolveSteamRef(input: string): Promise<SteamProfile | null> {
    let raw = input.trim().replace(/^@+/, "").replace(/\/+$/, "");
    // Strip protocol garbage so downstream regex is simpler
    raw = raw.replace(/^<|>$/g, "");

    let steamId: string | null = null;

    // Raw SteamID64 (17 digits starting with 7656)
    if (/^7656\d{13}$/.test(raw)) steamId = raw;

    // Trade URL: partner param → SteamID64
    if (!steamId) {
        const m = raw.match(/[?&]partner=(\d+)/);
        if (m) steamId = (76561197960265728n + BigInt(m[1])).toString();
    }

    // Profile URL: /profiles/76561...
    if (!steamId) {
        const m = raw.match(/\/profiles\/(7656\d{13})/);
        if (m) steamId = m[1];
    }

    // Vanity URL: /id/<name>, OR bare vanity name
    if (!steamId) {
        let vanity: string | null = null;
        const m = raw.match(/steamcommunity\.com\/id\/([^/?\s]+)/i);
        if (m) vanity = m[1];
        else if (!/[\s/]/.test(raw) && !/^\d+$/.test(raw)) vanity = raw;

        if (vanity) {
            try {
                const xml = await fetchText(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`);
                const m2 = xml.match(/<steamID64>(\d+)<\/steamID64>/);
                if (m2) steamId = m2[1];
            } catch (e) { console.warn("[VSI] vanity resolve failed", e); }
        }
    }

    if (!steamId) return null;

    // Fetch persona + avatar so the embed feels complete
    try {
        const xml = await fetchText(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
        const persona = xml.match(/<steamID>(?:<!\[CDATA\[)?([^\]<]+?)(?:\]\]>)?<\/steamID>/)?.[1];
        const avatar = xml.match(/<avatarFull>(?:<!\[CDATA\[)?([^\]<]+?)(?:\]\]>)?<\/avatarFull>/)?.[1];
        return { steamId, persona: persona?.trim(), avatar: avatar?.trim() };
    } catch {
        return { steamId };
    }
}

const SETTINGS_SCHEMA: Record<string, any> = {
    tradeUrl: {
        type: OptionType.STRING,
        description: "Your Steam trade offer URL. Grab it from steamcommunity.com/my/tradeoffers/privacy — this is what the Trade button opens.",
        default: "",
        placeholder: "https://steamcommunity.com/tradeoffer/new/?partner=...&token=...",
    },
    shareTradeUrl: {
        type: OptionType.BOOLEAN,
        description: "Share your trade URL with other addon users, so they get a Trade button on your profile even without it in your Discord bio. Turn off to keep it private — it stays saved here, but it's pulled from the shared cache and no one else sees it.",
        default: true,
    },
    buttonTheme: {
        type: OptionType.SELECT,
        description: "Color scheme for the Trade and Steam buttons.",
        options: [
            { label: "Blurple — Discord's brand purple", value: "blurple", default: true },
            { label: "Green — success-style accent", value: "green" },
            { label: "Steam Blue — dark navy → sky-blue gradient", value: "steam" },
            { label: "Dark — matte black minimal", value: "dark" },
            { label: "Auto — follows your Discord accent", value: "auto" },
        ],
    },
    showOnOwnProfile: {
        type: OptionType.BOOLEAN,
        description: "Show the Trade + Steam button row on your own profile popout.",
        default: true,
    },
    inventoryMode: {
        type: OptionType.SELECT,
        description: "When to show the CS2 Inventory card on someone's profile. 'Only users I enable' keeps profiles clean — right-click a user and toggle 'Show CS2 inventory' to turn it on just for them. Your own card always shows unless set to Off.",
        options: [
            { label: "Only users I enable (right-click)", value: "enabled", default: true },
            { label: "Every linked profile", value: "all" },
            { label: "Off", value: "off" },
        ],
    },

    // ── Prices ──────────────────────────────────────────────────────────────
    priceSource: {
        type: OptionType.SELECT,
        description: "Which marketplace's prices to use for /inventory.",
        options: [
            { label: "CSFloat — bulk (~300ms), refreshed hourly", value: "csfloat", default: true },
            { label: "Skinport — bulk (USD/GBP/EUR only)", value: "skinport" },
            { label: "Live Steam Market — always fresh, ~1min per inventory", value: "live_steam" },
        ],
    },
    marketCurrency: {
        type: OptionType.SELECT,
        description: "Currency for prices. CSFloat is USD-only under the hood — CSFloat mode ignores this. Steam Market and Skinport respect it.",
        options: [
            { label: "USD ($)", value: 1, default: true },
            { label: "CAD (C$)", value: 22 },
            { label: "GBP (£)", value: 2 },
            { label: "EUR (€)", value: 3 },
            { label: "AUD (A$)", value: 23 },
            { label: "CHF", value: 5 },
            { label: "PLN (zł)", value: 7 },
            { label: "BRL (R$)", value: 8 },
            { label: "SGD (S$)", value: 24 },
            { label: "JPY (¥)", value: 9 },
            { label: "RUB (₽)", value: 6 },
        ],
    },
    skinportPriceKind: {
        type: OptionType.SELECT,
        description: "Only applies when Price Source = Skinport. Which price to use.",
        options: [
            { label: "Suggested — Skinport's mid-market estimate", value: "suggested_price", default: true },
            { label: "Min — cheapest current listing", value: "min_price" },
            { label: "Median — middle of all listings", value: "median_price" },
            { label: "Mean — average of all listings", value: "mean_price" },
        ],
    },
    useLiveSteamFallback: {
        type: OptionType.BOOLEAN,
        description: "When on: after the bulk lookup, hit live Steam Market for anything the bulk feed missed (stickered/nametagged skins). Complete numbers but adds ~2s per missing item.",
        default: false,
    },
    csfloatApiKey: {
        type: OptionType.STRING,
        description: "Optional CSFloat API key (csfloat.com → Profile → Developer). When set, Doppler & Gamma Doppler knives are priced by their actual phase (Ruby/Sapphire/Black Pearl/Phase 1-4) instead of the generic blended price. Leave blank for generic prices.",
        default: "",
        placeholder: "CSFloat API key",
    },
    steamWebApiToken: {
        type: OptionType.STRING,
        description: "Optional Steam web token for YOUR OWN inventory. Steam's public inventory hides trade-held / restricted items (e.g. gloves & knives on a 7-day hold) from everyone but you — set this and your own card shows your FULL inventory. Get it (logged into Steam) from steamcommunity.com/pointssummary/ajaxgetasyncconfig and paste the webapi_token value. Read-only, your inventory only, expires ~24h — re-paste when items go missing.",
        default: "",
        placeholder: "webapi_token (eyJ0eXAiOi...)",
    },
    includeStickerValue: {
        type: OptionType.BOOLEAN,
        description: "Add applied-sticker value on top of each skin. Off by default — applied stickers rarely resell for much unless they're very rare, so counting full sticker value overstates what an inventory is actually worth. Turn on only if you want the theoretical sticker-book number.",
        default: false,
    },
    useSharedCache: {
        type: OptionType.BOOLEAN,
        description: "Use the shared inventory-value cache. When on, once anyone has priced a profile it loads instantly for everyone else (and phase-accurate prices propagate to users without a CSFloat key). Only the public SteamID + inventory value is shared — no Discord identity. Turn off to price everything locally.",
        default: true,
    },

    // ── Profile card behavior ───────────────────────────────────────────────
    showPriceChange: {
        type: OptionType.BOOLEAN,
        description: "Show a green/red delta chip on the card (e.g. +C$0.88 · 24h) when the total moved.",
        default: true,
    },
    deltaMinAgeMinutes: {
        type: OptionType.SELECT,
        description: "Window for the gain/loss chip — the change since the most recent snapshot at least this old. (No background pricing, so it needs a snapshot from that far back.)",
        options: [
            { label: "1 hour", value: 60 },
            { label: "6 hours", value: 360 },
            { label: "24 hours", value: 1440, default: true },
            { label: "7 days", value: 10080 },
        ],
    },
    topItemsCount: {
        type: OptionType.SELECT,
        description: "How many top items the card lists.",
        options: [
            { label: "3", value: 3 },
            { label: "5", value: 5, default: true },
            { label: "10", value: 10 },
        ],
    },
    showSparkline: {
        type: OptionType.BOOLEAN,
        description: "Show a mini price-history trend line on the card, drawn from your past snapshots (green when up, red when down), with all-time-high/low markers.",
        default: true,
    },
    showFlexBadges: {
        type: OptionType.BOOLEAN,
        description: "Show a value-milestone chip on the card ($1K / $5K / $10K …).",
        default: true,
    },
    itemClickAction: {
        type: OptionType.SELECT,
        description: "What LEFT-clicking an item in the breakdown does. Inspect / owner-inventory need the item's data, which fills in after the profile is (re)priced.",
        options: [
            { label: "Open its Steam Market listing", value: "market", default: true },
            { label: "Inspect in-game (opens CS2)", value: "inspect" },
            { label: "Find on CSFloat", value: "csfloat" },
            { label: "Price on Buff163", value: "buff" },
            { label: "View in the owner's Steam inventory", value: "inventory" },
        ],
    },
    rightClickAction: {
        type: OptionType.SELECT,
        description: "What RIGHT-clicking an item does. \"Menu\" pops a little list so you can pick the action per item; the others fire that action directly.",
        options: [
            { label: "Show a menu (pick per item)", value: "menu", default: true },
            { label: "Inspect in-game (opens CS2)", value: "inspect" },
            { label: "Find on CSFloat", value: "csfloat" },
            { label: "Price on Buff163", value: "buff" },
            { label: "View in the owner's Steam inventory", value: "inventory" },
            { label: "Open its Steam Market listing", value: "market" },
        ],
    },
    compactCard: {
        type: OptionType.BOOLEAN,
        description: "Compact card — show just the total, delta, sparkline and meta line; hide the top-items list (still one click away in the full breakdown).",
        default: false,
    },
    autoRefreshStale: {
        type: OptionType.BOOLEAN,
        description: "When you open a profile whose price is stale, silently re-price it in the background and update the card in place — no STALE tag, no manual refresh.",
        default: false,
    },
    backgroundRefresh: {
        type: OptionType.BOOLEAN,
        description: "Keep recently-viewed profiles freshly priced on a timer, so the gain/loss chip has a real data point at your chosen window — a true, consistent change on every card. The cadence follows your gain/loss window automatically (a 1h window re-prices hourly; longer windows cap at every ~6h). Light: a handful of price fetches spaced out, no constant CPU use. Turn off to only price profiles when you open them.",
        default: true,
    },
    resetHistory: {
        type: OptionType.BOOLEAN,
        description: "Wipe all stored price snapshots (deltas, sparkline, and diff) for every profile and start fresh. Flip on to clear — it resets itself right after.",
        default: false,
    },
    autoUpdateCheck: {
        type: OptionType.BOOLEAN,
        description: "Check GitHub for a newer version on load and offer a one-click update (it downloads and reloads itself — no manual re-download). Turn off to never check.",
        default: true,
    },
    showItemCount: {
        type: OptionType.BOOLEAN,
        description: 'Add "X items" to the card meta line.',
        default: false,
    },
    snapshotStalenessHours: {
        type: OptionType.NUMBER,
        description: "Mark the card as STALE if the last /inventory is older than this many hours. Set to 0 to never mark stale.",
        default: 24,
    },

    postPublicly: {
        type: OptionType.BOOLEAN,
        description: "When on: /inventory sends a real message to the channel (markdown, visible to everyone). When off: rich embed only you see.",
        default: false,
    },

    // ── Advanced ────────────────────────────────────────────────────────────
    priceCacheMinutes: {
        type: OptionType.NUMBER,
        description: "How long to keep the bulk price feed in memory before refetching. Skinport/CSFloat only refresh hourly on their end so 60 is fine.",
        default: 60,
    },
    requestDelayMs: {
        type: OptionType.NUMBER,
        description: "Live Steam Market only: delay between per-item requests, in milliseconds. 1600 keeps you under Steam's ~20/min rate limit. Bump if you 429.",
        default: 1600,
    },
};

// ─── /inventory command internals ─────────────────────────────────────────────

function getAccounts(profile: any): any[] {
    return profile?.connectedAccounts || profile?.connected_accounts || profile?.user?.connectedAccounts || [];
}

async function getSteamId(userId: string): Promise<string | null> {
    let profile: any = UserProfileStore.getUserProfile(userId);

    if (!getAccounts(profile).length) {
        const me = UserStore.getCurrentUser()?.id;
        const guildId = SelectedGuildStore?.getGuildId?.() || "";
        const attempts: string[] = [];
        if (userId === me) attempts.push("/users/@me/profile");
        if (guildId) attempts.push(`/users/${userId}/profile?guild_id=${guildId}&with_mutual_guilds=false`);
        attempts.push(`/users/${userId}/profile?with_mutual_guilds=false`);
        attempts.push(`/users/${userId}/profile`);

        for (const url of attempts) {
            try {
                const res: any = await RestAPI.get({ url });
                const body = res?.body;
                if (body && getAccounts(body).length) {
                    profile = body;
                    break;
                }
                if (body) profile = body;
            } catch (e: any) {
                console.warn("[VSI] profile fetch failed", url, e?.status || e?.message || e);
            }
        }
    }

    const accounts = getAccounts(profile);
    const steam = accounts.find((c: any) => c.type === "steam" || c.type === "STEAM");
    return steam?.id ?? null;
}

// Synchronous SteamID from the already-loaded profile store (no fetch) — powers the instant,
// skeleton-free card render when the profile is already in memory.
function getSteamIdSync(userId: string): string | null {
    const accounts = getAccounts(UserProfileStore.getUserProfile(userId));
    return accounts.find((c: any) => c.type === "steam" || c.type === "STEAM")?.id ?? null;
}

// Session-scoped price memo for live Steam per-item lookups: keyed by "name|currency"
const priceMemo = new Map<string, { price: number; ts: number }>();

// Session-scoped bulk feed cache: keyed by "source|currency|kind"
type PriceMap = Map<string, number>;
let bulkCache: { key: string; prices: PriceMap; ts: number } | null = null;

// Steam Market currency ID → ISO 4217 code (used for Skinport's `currency=` query param).
function currencyCode(cur: number): string {
    return ({
        1: "USD", 2: "GBP", 3: "EUR", 5: "CHF", 6: "RUB", 7: "PLN", 8: "BRL",
        9: "JPY", 22: "CAD", 23: "AUD", 24: "SGD",
    } as Record<number, string>)[cur] || "USD";
}

async function loadCsfloatBulk(): Promise<PriceMap> {
    // CSFloat's price-list is USD only, in cents. Free, no auth.
    const url = "https://csfloat.com/api/v1/listings/price-list";
    const arr: any[] = await fetchJson(url);
    const map: PriceMap = new Map();
    for (const it of arr) {
        const name = it?.market_hash_name;
        const cents = it?.min_price;
        if (typeof name === "string" && typeof cents === "number" && cents > 0) {
            map.set(name, cents / 100);
        }
    }
    return map;
}

async function loadSkinportBulk(): Promise<PriceMap> {
    const kind = settings.store.skinportPriceKind || "suggested_price";
    // Fetch in USD; getBulkPrices applies the FX conversion so every bulk source shares one path.
    const url = "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";
    const arr: any[] = await fetchJson(url);
    const map: PriceMap = new Map();
    for (const it of arr) {
        const name = it?.market_hash_name;
        const p = it?.[kind] ?? it?.suggested_price ?? it?.min_price;
        if (typeof name === "string" && typeof p === "number" && p > 0) map.set(name, p);
    }
    return map;
}

// USD→currency FX rate, cached 6h. Free, no-key endpoint. The bulk feeds (CSFloat, Skinport)
// are priced in USD, so we convert to the user's currency exactly the way CSFloat's own website
// does — a live FX multiply. Steam live-market prices are already native, so they skip this.
let fxCache: { code: string; rate: number; ts: number } | null = null;
async function getUsdRate(targetCode: string): Promise<number> {
    if (targetCode === "USD") return 1;
    if (fxCache && fxCache.code === targetCode && Date.now() - fxCache.ts < 6 * 3_600_000) return fxCache.rate;
    try {
        const data: any = await fetchJson("https://open.er-api.com/v6/latest/USD");
        const rate = data?.rates?.[targetCode];
        if (typeof rate === "number" && rate > 0) {
            fxCache = { code: targetCode, rate, ts: Date.now() };
            return rate;
        }
    } catch (e) {
        console.warn("[VSI] FX rate fetch failed, prices will show in USD", e);
    }
    return fxCache?.code === targetCode ? fxCache.rate : 1;
}

async function getBulkPrices(source: string): Promise<PriceMap> {
    const cur = settings.store.marketCurrency || 1;
    const kind = settings.store.skinportPriceKind || "suggested_price";
    const key = `${source}|${cur}|${kind}`;
    const ttl = (settings.store.priceCacheMinutes || 60) * 60_000;
    if (bulkCache && bulkCache.key === key && Date.now() - bulkCache.ts < ttl) {
        return bulkCache.prices;
    }
    let prices: PriceMap = new Map();
    if (source === "csfloat") prices = await loadCsfloatBulk();
    else if (source === "skinport") prices = await loadSkinportBulk();

    // Both bulk feeds are USD-denominated — convert to the user's chosen currency.
    const targetCode = currencyCode(cur);
    if (targetCode !== "USD" && prices.size) {
        const rate = await getUsdRate(targetCode);
        if (rate > 0 && rate !== 1) {
            const conv: PriceMap = new Map();
            for (const [k, v] of prices) conv.set(k, v * rate);
            prices = conv;
        }
    }
    bulkCache = { key, prices, ts: Date.now() };
    return prices;
}

function parseSteamPrice(raw: string): number {
    // Locale-agnostic: "$1,234.56" → 1234.56, "1.234,56€" → 1234.56, "12,34" → 12.34, "1,234" → 1234.
    // The LAST '.'/',' is the decimal separator ONLY if it has 1-2 trailing digits; a lone separator
    // with 3 trailing digits (and no other separator) is thousands grouping. All other separators
    // are thousands grouping and are stripped.
    const cleaned = String(raw).replace(/[^\d.,]/g, "");
    if (!cleaned) return 0;
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");
    const lastSep = Math.max(lastDot, lastComma);
    let normalized: string;
    if (lastSep === -1) {
        normalized = cleaned;
    } else if (cleaned.length - lastSep - 1 === 3 && (lastDot === -1 || lastComma === -1)) {
        normalized = cleaned.replace(/[.,]/g, ""); // single separator, 3 trailing digits → thousands
    } else {
        normalized = cleaned.slice(0, lastSep).replace(/[.,]/g, "") + "." + cleaned.slice(lastSep + 1);
    }
    const n = parseFloat(normalized);
    return isFinite(n) ? n : 0;
}

async function fetchSteamMarketPrice(marketHashName: string, currency: number): Promise<number> {
    const key = `${marketHashName}|${currency}`;
    const ttl = (settings.store.priceCacheMinutes || 60) * 60_000;
    const hit = priceMemo.get(key);
    if (hit && Date.now() - hit.ts < ttl) return hit.price;

    const url = `https://steamcommunity.com/market/priceoverview/?country=US&currency=${currency}&appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
    try {
        const data = await fetchJson(url);
        if (!data?.success) { priceMemo.set(key, { price: 0, ts: Date.now() }); return 0; }
        const raw = data.lowest_price ?? data.median_price ?? "";
        const price = parseSteamPrice(raw);
        priceMemo.set(key, { price, ts: Date.now() });
        return price;
    } catch (e: any) {
        // Rate-limit or transient error — don't cache, so next run retries
        if (String(e?.message || e).includes("429")) throw new Error("Steam rate-limited (429). Wait a minute and re-run.");
        throw e;
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One priced line in an inventory. `price` is the per-copy value INCLUDING applied stickers;
// `stickerValue`/`stickerCount` break out the sticker portion (for the badge). `icon` is the
// Steam icon_url hash; `qty` is how many identical (same skin + same stickers) copies.
interface PricedItem { name: string; price: number; qty: number; icon?: string; stickerValue?: number; stickerCount?: number; rarity?: string; hashName?: string; float?: number; seed?: number; nametag?: string; catType?: string; inspect?: string; assetid?: string; floatFlag?: "low" | "high" }

interface InventoryResult {
    total: number;
    priced: number;
    count: number; // total assets Steam returned
    marketableCount: number; // assets that can actually be sold on Steam Market
    uniqueNames: number; // distinct marketable market_hash_names
    isPrivate: boolean;
    topItems: { name: string; price: number; color?: string }[];
    allItems: PricedItem[]; // full priced list, sorted by value desc — modal + diff
    owned: Record<string, number>; // every marketable item by market_hash_name → qty (pricing-independent) — diff
    stickerTotal: number; // portion of `total` from applied stickers
    unpriced: string[]; // marketable but no price found
    skippedNonMarketable: number; // medals/coins/badges filtered out
}

// Applied stickers live in a description's HTML as <img title="Sticker: NAME">, one per copy
// (duplicates repeat). The market name to price each is "Sticker | NAME".
// Broad item category from Steam's "Type" tag internal_name, for the breakdown's type filter.
function normalizeType(internal: string): string {
    const m: Record<string, string> = {
        CSGO_Type_Pistol: "Pistols", CSGO_Type_SMG: "SMGs", CSGO_Type_Rifle: "Rifles",
        CSGO_Type_SniperRifle: "Snipers", CSGO_Type_Shotgun: "Heavy", CSGO_Type_Machinegun: "Heavy",
        CSGO_Type_Knife: "Knives", CSGO_Type_Hands: "Gloves", CSGO_Tool_Sticker: "Stickers",
        CSGO_Tool_Keychain: "Charms", CSGO_Type_MusicKit: "Music Kits", CSGO_Type_Spray: "Graffiti",
        CSGO_Type_Collectible: "Pins", CSGO_Type_WeaponCase: "Cases", CSGO_Tool_WeaponCase: "Cases",
    };
    if (m[internal]) return m[internal];
    if (/CustomPlayer/i.test(internal)) return "Agents";
    if (/Case|Capsule|Package/i.test(internal)) return "Cases";
    return "Other";
}

function parseStickers(desc: any): string[] {
    const out: string[] = [];
    for (const e of (desc?.descriptions ?? [])) {
        const v = e?.value;
        if (typeof v !== "string" || !v.includes("Sticker:")) continue;
        for (const m of v.matchAll(/title="Sticker: ([^"]+)"/g)) out.push(`Sticker | ${m[1]}`);
    }
    return out;
}

interface PricingOptions {
    source: string;
    useLiveFallback: boolean;
    onProgress?: (done: number, total: number) => void;
    // When set, the slow live-Steam fallback runs in the background and calls this with the
    // updated result once it finishes, so loadInventory can return the CSFloat total instantly.
    onUpdate?: (result: InventoryResult) => void;
}

// ── Doppler / Gamma Doppler phase pricing ──────────────────────────────────────
// Steam gives every Doppler the same market_hash_name, so the phase (Ruby, Sapphire,
// Black Pearl, Emerald, Phase 1-4) is invisible in the item name — and phases differ
// wildly in value (a Ruby is worth 10x a Phase 3). The item's `icon_url` DOES differ
// per phase, so we map icon_url → phase using the community ByMykel dataset. Phase-
// specific prices then come from CSFloat's authenticated listings API (the user's
// free API key); without a key we fall back to the generic blended price.
interface PhaseInfo { phase: string; paintIndex: number }
// One ByMykel fetch builds two maps: icon_url → Doppler phase, and skin name → {defindex,paintindex}
// (the latter feeds the FloatDB low/high-float lookup, which is keyed by defindex:paintindex).
let dopplerIconMap: Map<string, PhaseInfo> | null = null;
let skinMetaByName: Map<string, { defindex: number; paintindex: number }> = new Map();
let dopplerMapPromise: Promise<Map<string, PhaseInfo>> | null = null;
async function getDopplerIconMap(): Promise<Map<string, PhaseInfo>> {
    if (dopplerIconMap) return dopplerIconMap;
    if (!dopplerMapPromise) {
        dopplerMapPromise = (async () => {
            const map = new Map<string, PhaseInfo>();
            try {
                const skins: any[] = await fetchJson("https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json");
                for (const s of skins) {
                    const paintindex = s?.paint_index != null ? Number(s.paint_index) : null;
                    const defindex = s?.weapon?.weapon_id != null ? Number(s.weapon.weapon_id) : null;
                    if (typeof s?.name === "string" && defindex != null && paintindex != null && !skinMetaByName.has(s.name)) {
                        skinMetaByName.set(s.name, { defindex, paintindex });
                    }
                    if (!s?.phase || !s?.image || paintindex == null) continue;
                    const hash = String(s.image).split("/economy/image/")[1]?.split("/")[0];
                    if (hash) map.set(hash, { phase: s.phase, paintIndex: paintindex });
                }
            } catch (e) {
                console.warn("[VSI] ByMykel skin data fetch failed — Doppler phases & float ranks degrade", e);
            }
            dopplerIconMap = map;
            return map;
        })();
    }
    return dopplerMapPromise;
}
const isDopplerName = (name: string): boolean => /\bDoppler\b/i.test(name); // "Doppler" and "Gamma Doppler"

// FloatDB rank thresholds: for each skin (defindex:paintindex:stattrak:souvenir) the float at/below
// `low` is a ranked LOW-float and at/above `high` is a ranked HIGH-float. Public binary (~60KB),
// cached ~6h. Lets us flag notable-float items locally from the float we already have — no per-item
// inspect call needed, so it works for ANY inventory.
interface FloatThreshold { low: number; high: number }
let floatThresholds: Map<string, FloatThreshold> | null = null;
let floatThresholdsAt = 0;
let floatThresholdsPromise: Promise<Map<string, FloatThreshold>> | null = null;
async function getFloatThresholds(): Promise<Map<string, FloatThreshold>> {
    if (floatThresholds && Date.now() - floatThresholdsAt < 6 * 3_600_000) return floatThresholds;
    if (!floatThresholdsPromise) {
        floatThresholdsPromise = (async () => {
            const map = new Map<string, FloatThreshold>();
            try {
                const res = await BD.Net.fetch("https://gateway.floatdb.com/v1/ranks/thresholds/bin");
                if (res.ok) {
                    const view = new DataView(await res.arrayBuffer());
                    const entrySize = view.getUint8(1);
                    const count = view.getUint16(2, true);
                    for (let i = 0, off = 4; i < count; i++, off += entrySize) {
                        const defindex = view.getUint16(off, true);
                        const paintindex = view.getUint16(off + 2, true);
                        const flags = view.getUint8(off + 4);
                        map.set(`${defindex}:${paintindex}:${flags & 1}:${(flags >> 1) & 1}`, { low: view.getFloat32(off + 5, true), high: view.getFloat32(off + 9, true) });
                    }
                }
            } catch (e) { console.warn("[VSI] FloatDB thresholds fetch failed — float-rank badges off", e); }
            floatThresholds = map; floatThresholdsAt = Date.now();
            return map;
        })();
    }
    return floatThresholdsPromise;
}
// A ranked LOW / HIGH float flag for an item, or null. Needs its float + defindex/paintindex.
function floatFlagFor(rawName: string, float: number | undefined, paintIndexOverride: number | null,
    thresholds: Map<string, FloatThreshold>): "low" | "high" | null {
    if (float == null) return null;
    const base = rawName.replace(/^StatTrak™\s*/, "").replace(/^Souvenir\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    const meta = skinMetaByName.get(base);
    const defindex = meta?.defindex;
    const paintindex = paintIndexOverride ?? meta?.paintindex;
    if (defindex == null || paintindex == null) return null;
    const st = /StatTrak™/.test(rawName) ? 1 : 0;
    const souv = /^Souvenir /.test(rawName) ? 1 : 0;
    const t = thresholds.get(`${defindex}:${paintindex}:${st}:${souv}`);
    if (!t) return null;
    if (float <= t.low) return "low";
    if (float >= t.high) return "high";
    return null;
}

// CSFloat authenticated phase-specific lowest price (USD → user currency). Cached like the bulk feed.
// We filter by paint_index (the exact phase) — sorting the generic name by price would only ever
// surface the cheapest phases, never the user's Phase 2 / Ruby / Sapphire / Black Pearl.
const phasePriceCache = new Map<string, { price: number; ts: number }>();
async function getCsfloatPhasePrice(marketHashName: string, paintIndex: number): Promise<number | null> {
    const apiKey = (settings.store.csfloatApiKey || "").trim();
    if (!apiKey) return null;
    const cur = settings.store.marketCurrency || 1;
    const cacheKey = `${marketHashName}::${paintIndex}::${cur}`;
    const ttl = (settings.store.priceCacheMinutes || 60) * 60_000;
    const hit = phasePriceCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < ttl) return hit.price;
    try {
        const url = `https://csfloat.com/api/v1/listings?sort_by=lowest_price&limit=1&market_hash_name=${encodeURIComponent(marketHashName)}&paint_index=${paintIndex}`;
        const resp: any = await fetchJson(url, { headers: { Authorization: apiKey } });
        const list: any[] = Array.isArray(resp) ? resp : (resp?.data ?? []);
        const cents = list[0]?.price;
        if (typeof cents !== "number" || cents <= 0) return null;
        let price = cents / 100; // CSFloat prices are USD cents
        const targetCode = currencyCode(cur);
        if (targetCode !== "USD") { const r = await getUsdRate(targetCode); if (r > 0) price *= r; }
        phasePriceCache.set(cacheKey, { price, ts: Date.now() });
        return price;
    } catch (e) {
        console.warn("[VSI] CSFloat phase price failed for", marketHashName, paintIndex, e);
        return null;
    }
}

// A Steam webapi_token's owner SteamID (its JWT `sub`). Used to detect "this is my own inventory".
function base64UrlDecode(s: string): string {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return atob(s);
}
function tokenSteamId(token: string): string | null {
    try { const p = JSON.parse(base64UrlDecode(token.split(".")[1] || "")); return typeof p?.sub === "string" ? p.sub : null; } catch { return null; }
}

async function loadInventory(steamId: string, opts: PricingOptions): Promise<InventoryResult> {
    const empty = (isPriv: boolean): InventoryResult => ({
        total: 0, priced: 0, count: 0, marketableCount: 0, uniqueNames: 0, isPrivate: isPriv, topItems: [], allItems: [], owned: {}, stickerTotal: 0, unpriced: [], skippedNonMarketable: 0,
    });

    // Steam's inventory endpoint PAGINATES. Without an explicit count it returns only a partial
    // first page (~a few hundred items) with `more_items: 1` — so large inventories silently lose
    // everything past that page (knives, gloves, and any newly-added item can land off-page).
    // We must pass count=2000 (Valve's per-request max; higher 400s) AND follow the `last_assetid`
    // cursor until the inventory is exhausted.
    const assets: any[] = [];
    const descriptions: any[] = [];
    const assetProps: any[] = []; // per-asset float/seed/nametag/inspect — returned for ANY public inventory
    const seenDesc = new Set<string>();

    // Own inventory + a valid webapi_token → the AUTHENTICATED endpoint, which returns the FULL
    // inventory including trade-held / restricted items (gloves, knives on a hold) that the public
    // endpoint hides from anonymous viewers. Everyone else (and if the token is missing/expired)
    // uses the public endpoint. Both paginate the same way (more_items / last_assetid).
    const token = (settings.store.steamWebApiToken || "").trim();
    const useAuth = !!token && tokenSteamId(token) === steamId;
    const urlFor = (auth: boolean, start?: string): string => auth
        ? `https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/?${new URLSearchParams({ access_token: token, steamid: steamId, appid: "730", contextid: "2", get_descriptions: "true", get_asset_properties: "true", count: "2000", ...(start ? { start_assetid: start } : {}) })}`
        : `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000${start ? `&start_assetid=${start}` : ""}`;
    const paginate = async (auth: boolean): Promise<void> => {
        let start: string | undefined; let pages = 0;
        do {
            const raw: any = await fetchJson(urlFor(auth, start));
            const page: any = auth ? (raw?.response ?? {}) : raw;
            if (!page?.assets || !page?.descriptions) break; // blocked / empty page
            assets.push(...page.assets);
            if (Array.isArray(page.asset_properties)) assetProps.push(...page.asset_properties);
            for (const d of page.descriptions) {
                const k = `${d.classid}_${d.instanceid}`;
                if (!seenDesc.has(k)) { seenDesc.add(k); descriptions.push(d); }
            }
            start = page.more_items ? String(page.last_assetid) : undefined;
            pages++;
            if (start) await sleep(auth ? 300 : 600); // be gentle — Steam rate-limits inventory requests
        } while (start && pages < 8);
    };

    if (useAuth) { try { await paginate(true); } catch { /* token expired/invalid → fall back to public */ } }
    if (assets.length === 0) {
        try { await paginate(false); }
        catch (e: any) {
            if (String(e?.message || e).includes("403")) return empty(true);
            if (assets.length === 0) throw e; // nothing fetched → surface the error; else price partial
        }
    }
    if (assets.length === 0) return empty(true);
    const inv = { assets, descriptions };

    // Per-asset float (propertyid 2 "Wear Rating"), paint seed (1 "Pattern Template") and the custom
    // Name Tag (5) — all in Steam's public inventory response, available for ANY public inventory, no auth.
    const floatMap = new Map<string, { float?: number; seed?: number; nametag?: string; inspect?: string }>();
    for (const w of assetProps) {
        let fl: number | undefined, sd: number | undefined, nt: string | undefined, ins: string | undefined;
        for (const p of (w.asset_properties ?? [])) {
            const id = Number(p.propertyid);
            if (id === 2 && p.float_value != null) { const v = Number(p.float_value); if (v >= 0 && v <= 1) fl = v; }
            else if (id === 1 && p.int_value != null) { const v = Number(p.int_value); if (v >= 0 && v <= 1000) sd = v; }
            else if (id === 5 && typeof p.string_value === "string" && p.string_value.trim()) nt = p.string_value.trim().slice(0, 60);
            else if (id === 6 && typeof p.string_value === "string" && p.string_value.trim()) ins = p.string_value.trim(); // "Item Certificate" = inspect payload
        }
        if (fl != null || sd != null || nt || ins) floatMap.set(String(w.assetid), { float: fl, seed: sd, nametag: nt, inspect: ins });
    }

    // Steam's `marketable` (0/1) tells us if the item can even be listed on the Market.
    // Medals, service coins, achievement badges, non-tradeable capsules etc. have marketable=0.
    // We skip those entirely — otherwise we'd hit CSFloat/Steam for nothing and pad the "missing" list.
    // For Dopplers we also resolve the phase from the icon so a Ruby isn't priced as a Phase 3.
    const dopMap = await getDopplerIconMap();
    const thresholds = await getFloatThresholds().catch(() => new Map()); // low/high-float rank cutoffs
    const wantStickers = settings.store.includeStickerValue === true; // strict opt-in; base value by default
    interface Meta { name: string; marketable: boolean; phase: string | null; paintIndex: number | null; icon: string; stickers: string[]; rarity: string; catType: string }
    const metaByKey = new Map<string, Meta>();
    for (const d of inv.descriptions) {
        const name = d.market_hash_name;
        const dp = (isDopplerName(name) && d.icon_url) ? (dopMap.get(d.icon_url) ?? null) : null;
        const typeTag = (d.tags ?? []).find((t: any) => t.category === "Type")?.internal_name ?? "";
        metaByKey.set(`${d.classid}_${d.instanceid}`, {
            name,
            marketable: d.marketable === 1 || d.marketable === "1" || d.marketable === true, // public: 0/1, authed: boolean
            phase: dp?.phase ?? null,
            paintIndex: dp?.paintIndex ?? null,
            icon: d.icon_url ?? "",
            stickers: wantStickers ? parseStickers(d) : [],
            catType: normalizeType(typeTag),
            // Steam's per-item `name_color` (hex, no #) IS the CS2 rarity grade — b0c3d9 consumer …
            // eb4b4b covert … e4ae39 contraband. We tint the card/modal rows by it.
            rarity: typeof d.name_color === "string" ? d.name_color.replace(/^#/, "").toLowerCase() : "",
        });
    }

    // Group identical items. Dopplers group by name+phase; stickered copies group by their sticker
    // set too, so a 4×-Katowice AK isn't averaged in with a bare one (each sticker set prices apart).
    interface Group { name: string; phase: string | null; paintIndex: number | null; qty: number; icon: string; stickers: string[]; rarity: string; assetids: string[]; catType: string }
    const groups = new Map<string, Group>();
    const owned = new Map<string, number>(); // every marketable item by name → qty, pricing-independent (diff)
    let marketableCount = 0;
    let skippedNonMarketable = 0;
    for (const a of inv.assets) {
        const meta = metaByKey.get(`${a.classid}_${a.instanceid}`);
        if (!meta) continue;
        if (!meta.marketable) { skippedNonMarketable++; continue; }
        marketableCount++;
        owned.set(meta.name, (owned.get(meta.name) ?? 0) + 1);
        const stickerSig = meta.stickers.length ? meta.stickers.slice().sort().join("|") : "";
        const gk = `${meta.name}::${meta.phase ?? ""}::${stickerSig}`;
        const g = groups.get(gk);
        if (g) { g.qty++; g.assetids.push(a.assetid); }
        else groups.set(gk, { name: meta.name, phase: meta.phase, paintIndex: meta.paintIndex, qty: 1, icon: meta.icon, stickers: meta.stickers, rarity: meta.rarity, assetids: [a.assetid], catType: meta.catType });
    }
    const uniqueNames = [...new Set([...groups.values()].map(g => g.name))];

    // ── Generic (name-keyed) pricing: bulk feed. Live Steam fills the misses later. ──
    const priceByName = new Map<string, number>();
    const misses: string[] = [];
    let bulk: PriceMap = new Map();
    if (opts.source !== "live_steam") {
        bulk = await getBulkPrices(opts.source);
        for (const name of uniqueNames) {
            const p = bulk.get(name);
            if (p && p > 0) priceByName.set(name, p);
            else misses.push(name);
        }
    } else {
        misses.push(...uniqueNames);
    }

    // ── Per-group pricing (bulk + Doppler phase + applied stickers). Fast: no per-item Steam calls.
    //    Sticker prices come from the same bulk feed (keyed "Sticker | NAME"), already in the user's
    //    currency, and are added on top of the base skin price. ──
    const priceByGroup = new Map<string, number>();
    const stickerByGroup = new Map<string, { value: number; count: number }>();
    const hasKey = !!(settings.store.csfloatApiKey || "").trim();
    for (const [gk, g] of groups) {
        let base: number | null = null;
        if (g.phase && g.paintIndex != null && hasKey) {
            base = await getCsfloatPhasePrice(g.name, g.paintIndex);
            await sleep(350); // gentle on CSFloat's API
        }
        if (base == null) base = priceByName.get(g.name) ?? null;
        if (base == null) continue; // unpriced base → leave for the live fallback
        // Souvenir skins carry non-removable, baked-in tournament stickers already reflected in the
        // souvenir's own price — valuing those as standalone stickers wildly overstates them.
        const isSouvenir = /^Souvenir /.test(g.name);
        let stickerVal = 0;
        if (!isSouvenir) for (const sn of g.stickers) { const sp = bulk.get(sn); if (sp && sp > 0) stickerVal += sp; }
        priceByGroup.set(gk, base + stickerVal);
        if (stickerVal > 0) stickerByGroup.set(gk, { value: stickerVal, count: g.stickers.length });
    }

    // Assemble an InventoryResult from the current price maps (re-run after the fallback fills misses).
    const buildResult = (): InventoryResult => {
        const unpriced: string[] = [];
        for (const [gk, g] of groups) if (!priceByGroup.has(gk)) unpriced.push(g.phase ? `${g.name} (${g.phase})` : g.name);
        let total = 0, priced = 0, stickerTotal = 0;
        const perItem: PricedItem[] = [];
        for (const [gk, g] of groups) {
            const p = priceByGroup.get(gk);
            if (p == null) continue;
            total += p * g.qty;
            priced += g.qty;
            const sm = stickerByGroup.get(gk);
            if (sm) stickerTotal += sm.value * g.qty;
            // Per-item float/seed/nametag only make sense for a single copy — attach to singleton groups.
            const ap = g.qty === 1 ? floatMap.get(g.assetids[0]) : undefined;
            const floatFlag = ap?.float != null ? (floatFlagFor(g.name, ap.float, g.paintIndex, thresholds) ?? undefined) : undefined;
            perItem.push({ name: g.phase ? `${g.name} (${g.phase})` : g.name, price: p, qty: g.qty, icon: g.icon, stickerValue: sm?.value, stickerCount: sm?.count, rarity: g.rarity || undefined, hashName: g.name, float: ap?.float, seed: ap?.seed, nametag: ap?.nametag, catType: g.catType, inspect: ap?.inspect, assetid: g.qty === 1 ? g.assetids[0] : undefined, floatFlag });
        }
        perItem.sort((a, b) => (b.price * b.qty) - (a.price * a.qty));
        const topItems = perItem.slice(0, 10).map(i => ({ name: i.qty > 1 ? `${i.name} ×${i.qty}` : i.name, price: i.price * i.qty, color: i.rarity }));
        return { total, priced, count: inv.assets.length, marketableCount, uniqueNames: uniqueNames.length, isPrivate: false, topItems, allItems: perItem, owned: Object.fromEntries(owned), stickerTotal, unpriced: unpriced.slice(0, 5), skippedNonMarketable };
    };

    // ── Live Steam Market fallback for CSFloat's misses (charms/passes/graffiti it doesn't list).
    //    Steam rate-limits to ~1 request/1.6s, so this is the slow part. When an onUpdate callback
    //    is supplied we run it in the BACKGROUND and push an updated result when it finishes —
    //    returning the CSFloat-priced total instantly. Without a callback (or for the live_steam
    //    source, where there is no fast result) we run it inline. ──
    const shouldRunLive = opts.source === "live_steam" || (opts.useLiveFallback && misses.length > 0);
    const runFallback = async () => {
        const currency = settings.store.marketCurrency || 1;
        const delay = Math.max(500, settings.store.requestDelayMs || 1600);
        for (let i = 0; i < misses.length; i++) {
            const name = misses[i];
            try {
                const p = await fetchSteamMarketPrice(name, currency);
                if (p > 0) {
                    priceByName.set(name, p);
                    for (const [gk, g] of groups) if (!priceByGroup.has(gk) && !g.phase && g.name === name) priceByGroup.set(gk, p);
                }
            } catch (e: any) {
                // Steam 429s aggressively. Once rate-limited, every further request also 429s,
                // so stop the whole fallback (one line, no flood) instead of hammering the API.
                if (String(e?.message || e).includes("429")) {
                    console.warn("[VSI] Steam rate-limited — skipping the remaining live-price fallback");
                    break;
                }
                console.warn("[VSI] live price fetch failed for", name, e);
            }
            opts.onProgress?.(i + 1, misses.length);
            if (i < misses.length - 1) await sleep(delay);
        }
    };

    if (shouldRunLive && misses.length > 0) {
        if (opts.onUpdate && opts.source !== "live_steam") {
            runFallback().then(() => { try { opts.onUpdate!(buildResult()); } catch { /* */ } }).catch(() => { /* */ });
        } else {
            await runFallback();
        }
    }

    return buildResult();
}

function currencySymbol(c: number): string {
    return ({
        1: "$", 2: "£", 3: "€", 5: "CHF ", 6: "₽", 7: "zł ", 8: "R$",
        9: "¥", 22: "C$", 23: "A$", 24: "S$",
    } as Record<number, string>)[c] || "$";
}
const fmt = (n: number, cur = 1) => `${currencySymbol(cur)}${n.toFixed(2)}`;

function abbrevItem(name: string): string {
    return name
        .replace(/\(Factory New\)/gi, "(FN)")
        .replace(/\(Minimal Wear\)/gi, "(MW)")
        .replace(/\(Field-Tested\)/gi, "(FT)")
        .replace(/\(Well-Worn\)/gi, "(WW)")
        .replace(/\(Battle-Scarred\)/gi, "(BS)")
        .replace(/StatTrak™\s*/g, "ST ")
        .replace(/Souvenir\s+/g, "Souv ")
        .replace(/★\s*/g, "★ ");
}

// ─── Snapshot persistence for +/- delta ──────────────────────────────────────
interface Snapshot {
    total: number;
    priced: number;
    itemCount: number;
    marketableCount?: number;
    uniqueNames: number;
    ts: number;
    source: string;
    currency: number;
    topItems?: { name: string; price: number; color?: string }[];
    stickerTotal?: number; // portion of total from applied stickers (local snapshots only)
    rank?: number;   // global leaderboard position (1 = richest), from the shared cache
    tracked?: number; // how many inventories the cache is tracking
    series?: number[]; // shared value history (display currency, oldest→newest) — from the cache,
                       // used to draw a sparkline on a first/foreign view before local history exists
}

const snapKey = (steamId: string) => `vsi.snap.${steamId}`;

async function getSnapshots(steamId: string): Promise<Snapshot[]> {
    return (await DataStore.get(snapKey(steamId))) ?? [];
}
// BdApi.Data.load is synchronous under the hood — these read the same data with no await,
// so a card whose snapshot is already stored can render immediately (no loading skeleton).
const getSnapshotsSync = (steamId: string): Snapshot[] => BD.Data.load(PLUGIN_NAME, snapKey(steamId)) ?? [];
const getItemsSnapsSync = (steamId: string): ItemsSnapshot[] => BD.Data.load(PLUGIN_NAME, itemsKey(steamId)) ?? [];

const SNAP_COALESCE_MS = 20 * 60_000; // re-prices within this window replace the newest point
async function pushSnapshot(steamId: string, snap: Snapshot) {
    const list = await getSnapshots(steamId);
    // Coalesce: a manual refresh fires the fast CSFloat price AND the fuller Steam-fallback price,
    // and users hit ↻ repeatedly — each would otherwise add a sparkline point and turn the line
    // into a sawtooth. Replace the newest point when it's within the window (same currency) so the
    // sparkline stays a real time-series, not a refresh counter.
    const prev = list[0];
    if (prev && (snap.ts - prev.ts) < SNAP_COALESCE_MS && (prev.currency || 1) === (snap.currency || 1)) list[0] = snap;
    else list.unshift(snap);
    // Keep ~10 days at the 6h background cadence, so even a 7-day delta window has a data point.
    await DataStore.set(snapKey(steamId), list.slice(0, 40));
}

// Full priced item lists are heavy (hundreds of entries), so they live apart from the light
// snapshot history: we keep only the few most recent runs — [0] powers the breakdown modal,
// [0] vs [1] powers the "what changed" diff.
interface ItemsSnapshot { ts: number; currency: number; total: number; items: PricedItem[]; owned?: Record<string, number> }
const itemsKey = (steamId: string) => `vsi.items.${steamId}`;

async function getItemsSnaps(steamId: string): Promise<ItemsSnapshot[]> {
    return (await DataStore.get(itemsKey(steamId))) ?? [];
}

function sameOwned(a?: Record<string, number>, b?: Record<string, number>): boolean {
    if (!a || !b) return false;
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) if (a[k] !== b[k]) return false;
    return true;
}

// Delete every stored snapshot/items key (all profiles). Goes through BdApi.Data so BetterDiscord's
// in-memory cache is updated too — editing the config file directly gets clobbered on the next save.
// Keys are enumerated from the on-disk config (which mirrors the cache) since BdApi.Data has no list().
function clearAllHistory(): number {
    try {
        const fs = require("fs");
        const folder = (BD as any).Plugins?.folder;
        const cfg = folder ? `${folder}/${PLUGIN_NAME}.config.json` : null;
        if (!cfg || !fs.existsSync(cfg)) return 0;
        const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
        const keys = Object.keys(data).filter(k => k.startsWith("vsi.snap.") || k.startsWith("vsi.items."));
        for (const k of keys) BD.Data.delete(PLUGIN_NAME, k);
        return keys.length;
    } catch (e) { console.error("[VSI] clearAllHistory", e); return 0; }
}

async function pushItemsSnap(steamId: string, snap: ItemsSnapshot) {
    const list = await getItemsSnaps(steamId);
    // A new history entry only when the OWNED set actually changed — re-prices of the same
    // inventory update the latest entry in place, so the diff spans real inventory changes.
    const prev = list[0];
    if (prev && sameOwned(prev.owned, snap.owned)) {
        list[0] = snap;
    } else {
        list.unshift(snap);
    }
    await DataStore.set(itemsKey(steamId), list.slice(0, 3));
}

// "What changed" between the two most recent snapshots — compared on the OWNED item set
// (every marketable item by name, independent of pricing), so items flipping in/out of the
// PRICED subset (background Steam fallback, feed gaps, the sticker toggle) never show up as
// phantom gains/losses. Only real inventory changes count. Returns null when nothing changed
// or when a snapshot predates owned-tracking.
type DiffEntry = { name: string; qty: number; price: number };
const buildDiffLine = async (steamId: string): Promise<string | null> => diffLineFromSnaps(await getItemsSnaps(steamId));
const buildDiffLineSync = (steamId: string): string | null => diffLineFromSnaps(getItemsSnapsSync(steamId));

function diffLineFromSnaps(snaps: ItemsSnapshot[]): string | null {
    if (snaps.length < 2) return null;
    const [cur, prev] = snaps;
    if (!cur.owned || !prev.owned) return null; // pre-owned snapshot → can't diff reliably
    // Best-effort price for a name, from the current run's priced items (for ordering the labels).
    const priceOf = (name: string): number => {
        let best = 0;
        // Exact, or the phase-suffixed variant ("… (Ruby)") — the " (" guard avoids matching an
        // unrelated longer name that merely shares this prefix.
        for (const it of cur.items) if (it.name === name || it.name.startsWith(name + " (")) best = Math.max(best, it.price);
        return best;
    };
    const added: DiffEntry[] = [];
    const removed: DiffEntry[] = [];
    for (const [name, q] of Object.entries(cur.owned)) { const d = q - (prev.owned[name] ?? 0); if (d > 0) added.push({ name, qty: d, price: priceOf(name) }); }
    for (const [name, q] of Object.entries(prev.owned)) { const d = q - (cur.owned[name] ?? 0); if (d > 0) removed.push({ name, qty: d, price: priceOf(name) }); }
    if (!added.length && !removed.length) return null;
    const label = (arr: DiffEntry[]) => {
        const top = arr.slice().sort((a, b) => b.price - a.price).slice(0, 2)
            .map(i => `${abbrevItem(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ""}`);
        return arr.length > 2 ? `${top.join(", ")} +${arr.length - 2} more` : top.join(", ");
    };
    const parts: string[] = [];
    if (added.length) parts.push(`gained ${label(added)}`);
    if (removed.length) parts.push(`dropped ${label(removed)}`);
    return `${parts.join(" · ")} · ${humanAgo(cur.ts - prev.ts)}`;
}

// ─── Shared inventory-value cache (SteamID-keyed, USD-canonical) ────────────────
// Read-through cache: once anyone prices a profile, everyone else loads it instantly,
// and phase-accurate Doppler prices (from whoever holds a CSFloat key) propagate to
// keyless users. Only public SteamID + inventory value is stored — no Discord identity.
// Values are canonical USD; each client applies its own FX so currencies share entries.
const CACHE_WORKER = "https://vsi-cache.reap-dev.workers.dev";
const CACHE_FRESH_MS = 25 * 60_000; // entries younger than this are used as-is

async function fxFor(cur: number): Promise<number> {
    const code = currencyCode(cur);
    return code === "USD" ? 1 : await getUsdRate(code);
}

async function cacheGetInventory(steamId: string, cur: number): Promise<Snapshot | null> {
    if (!settings.store.useSharedCache) return null;
    try {
        const data: any = await fetchJson(`${CACHE_WORKER}/inv/${steamId}`);
        if (!data?.found || typeof data.total_usd !== "number") return null;
        if (Date.now() - (data.ts || 0) > CACHE_FRESH_MS) return null; // stale → re-price locally
        const fx = await fxFor(cur);
        return {
            total: data.total_usd * fx,
            priced: data.priced ?? 0,
            itemCount: data.item_count ?? 0,
            marketableCount: data.marketable_count ?? 0,
            uniqueNames: data.unique_names ?? 0,
            ts: data.ts,
            source: "csfloat",
            currency: cur,
            topItems: (data.top_items ?? []).map((t: any) => ({ name: t.name, price: (t.price_usd ?? 0) * fx, color: t.color })),
            rank: typeof data.rank === "number" ? data.rank : undefined,
            tracked: typeof data.tracked === "number" ? data.tracked : undefined,
            series: Array.isArray(data.series) ? data.series.filter((v: any) => typeof v === "number").map((v: number) => v * fx) : undefined,
        };
    } catch { return null; }
}

// Returns the pusher's fresh {rank, tracked} from the worker so the card can show a rank chip
// without an extra round-trip. null when the cache is off or the push failed.
async function cachePushInventory(steamId: string, snap: Snapshot, name?: string): Promise<{ rank: number; tracked: number } | null> {
    if (!settings.store.useSharedCache) return null;
    try {
        const fx = await fxFor(snap.currency || 1);
        if (!fx) return null;
        const guildId = SelectedGuildStore?.getGuildId?.() || "";
        const res: any = await fetchJson(`${CACHE_WORKER}/inv/${steamId}`, {
            method: "POST",
            body: {
                total_usd: snap.total / fx,
                priced: snap.priced,
                item_count: snap.itemCount,
                marketable_count: snap.marketableCount ?? 0,
                unique_names: snap.uniqueNames,
                top_items: (snap.topItems ?? []).map(t => ({ name: t.name, price_usd: t.price / fx, ...(t.color ? { color: t.color } : {}) })),
                ...(name ? { name } : {}),
                // Records this inventory on the current server's board too (for /leaderboard here).
                ...(guildId ? { guild_id: guildId } : {}),
            },
        });
        return (res && typeof res.rank === "number") ? { rank: res.rank, tracked: res.tracked ?? 0 } : null;
    } catch { return null; /* cache is best-effort */ }
}

// Leaderboard of the richest cached inventories (USD-canonical → local FX at render). Pass a
// guildId to get that server's board (only inventories priced while someone was in it).
async function cacheGetLeaderboard(limit: number, cur: number, guildId?: string): Promise<{ steamId: string; total: number; name?: string }[]> {
    try {
        const q = `limit=${limit}${guildId ? `&guild=${encodeURIComponent(guildId)}` : ""}`;
        const data: any = await fetchJson(`${CACHE_WORKER}/leaderboard?${q}`);
        const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
        const fx = await fxFor(cur);
        return entries.map(e => ({ steamId: String(e.steamId), total: (e.total_usd ?? 0) * fx, name: e.name }));
    } catch { return []; }
}

// Publish the local user's own trade URL to the shared cache, keyed by their SteamID (derived
// from the URL's partner). Then every other addon user sees a Trade button on this person's
// profile even if it isn't in their Discord bio. Best-effort; the worker verifies the partner.
async function cachePushTradeUrl(): Promise<void> {
    if (!settings.store.useSharedCache) return;
    const tradeUrl = settings.store.tradeUrl?.trim();
    if (!tradeUrl) return;
    const steamId = steamIdFromTradeUrl(tradeUrl);
    if (!steamId) return;
    // "Share Trade URL" off → don't publish, and pull any existing entry so others stop seeing it.
    const method = settings.store.shareTradeUrl === false ? "DELETE" : "POST";
    try {
        await fetchJson(`${CACHE_WORKER}/trade/${steamId}`, { method, body: { trade_url: tradeUrl } });
    } catch { /* best-effort */ }
}

async function cacheGetTradeUrl(steamId: string): Promise<string | null> {
    if (!settings.store.useSharedCache) return null;
    try {
        const data: any = await fetchJson(`${CACHE_WORKER}/trade/${steamId}`);
        return data?.found && typeof data.trade_url === "string" ? data.trade_url : null;
    } catch { return null; }
}

function humanAgo(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
}

// A fixed window label for the delta chip — the same on every card (e.g. "24h", "7d"), so the
// timeframe is consistent across all profiles regardless of when each was last priced.
function windowLabel(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const h = minutes / 60;
    if (h < 24) return `${h}h`;
    return (h % 24 === 0 && h / 24 >= 7) ? `${h / 24}d` : `${h}h`;
}

function computeDelta(currentTotal: number, snaps: Snapshot[], minAgeMs: number): { delta: number; ago: string } | null {
    const now = Date.now();
    // `snaps` excludes the current run. Compare against the snapshot CLOSEST to `window` ago, so the
    // chip always reflects the change over that fixed window (labeled the same on every card). With
    // no background pricing the nearest snapshot may not be exactly `window` old — its true age is
    // surfaced in the tooltip — but the visible timeframe stays consistent across profiles.
    const differing = snaps.filter(s => s.total !== currentTotal);
    if (!differing.length) return null;
    const target = now - minAgeMs;
    let prev = differing[0], best = Infinity;
    for (const s of differing) { const gap = Math.abs(s.ts - target); if (gap < best) { best = gap; prev = s; } }
    return { delta: currentTotal - prev.total, ago: humanAgo(now - prev.ts) };
}

function formatDeltaText(delta: number, ago: string, cur: number): string {
    const sign = delta >= 0 ? "+" : "";
    const emoji = delta > 0 ? "📈" : delta < 0 ? "📉" : "➖";
    return `${emoji} ${sign}${fmt(delta, cur).replace(currencySymbol(cur), currencySymbol(cur))} since ${ago}`;
}

// ─── Trade button injection ───────────────────────────────────────────────────

const STEAM_ICON_SVG = "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M11.98 2C6.7 2 2.36 6.03 2 11.13l5.38 2.22a2.86 2.86 0 0 1 1.6-.48h.15l2.4-3.47v-.05a3.83 3.83 0 1 1 3.83 3.83h-.09l-3.42 2.44v.13a2.87 2.87 0 0 1-5.42 1.3L2.5 15.5A9.99 9.99 0 0 0 22 12c0-5.52-4.48-10-10.02-10ZM8.79 17.16l-1.22-.5a2.16 2.16 0 0 0 1.15 1.13c1.09.45 2.35-.06 2.8-1.16.22-.53.22-1.11 0-1.64a2.15 2.15 0 0 0-1.14-1.16 2.14 2.14 0 0 0-1.64.01l1.26.52a1.59 1.59 0 1 1-1.21 2.94v-.14Zm10.02-7.6a2.55 2.55 0 0 1-5.11 0 2.55 2.55 0 0 1 5.11 0Zm-4.47 0a1.92 1.92 0 1 0 3.83 0 1.92 1.92 0 0 0-3.83 0Z\"/></svg>";
const USER_ICON_SVG = "<svg viewBox=\"0 0 24 24\" width=\"15\" height=\"15\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4.42 0-8 2.24-8 5v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2c0-2.76-3.58-5-8-5Z\"/></svg>";

// Match `steamcommunity.com/tradeoffer/new/?partner=...&token=...` anywhere in a string.
const TRADE_URL_RE = /https?:\/\/(?:www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+(?:&(?:amp;)?token=[A-Za-z0-9_-]+)?/i;

function extractTradeUrl(text: string | undefined | null): string | null {
    if (!text) return null;
    const m = text.match(TRADE_URL_RE);
    if (!m) return null;
    // Un-HTML-entity the &amp; that Discord bios sometimes contain.
    return m[0].replace(/&amp;/g, "&");
}

async function getTradeUrlForUser(userId: string): Promise<string | null> {
    // Try Vencord/Discord profile cache first, no network hit.
    const profile: any = UserProfileStore.getUserProfile(userId);
    let bio: string | undefined = profile?.bio ?? profile?.userProfile?.bio ?? profile?.user_profile?.bio;
    if (!bio) {
        // Fall through to a REST fetch (uses the same param dance as getSteamId).
        const guildId = SelectedGuildStore?.getGuildId?.() || "";
        const attempts: string[] = [];
        if (guildId) attempts.push(`/users/${userId}/profile?guild_id=${guildId}&with_mutual_guilds=false`);
        attempts.push(`/users/${userId}/profile?with_mutual_guilds=false`);
        for (const url of attempts) {
            try {
                const res: any = await RestAPI.get({ url });
                const body = res?.body;
                bio = body?.user_profile?.bio ?? body?.userProfile?.bio ?? body?.bio;
                if (bio) break;
            } catch { /* try next */ }
        }
    }
    return extractTradeUrl(bio ?? null);
}

// SteamID64 a trade URL belongs to, from its `partner` (32-bit account id).
function steamIdFromTradeUrl(tradeUrl: string): string | null {
    try {
        const partner = new URL(tradeUrl).searchParams.get("partner");
        if (!partner || !/^\d+$/.test(partner)) return null;
        return (76561197960265728n + BigInt(partner)).toString();
    } catch {
        return null;
    }
}

function deriveSteamProfileUrl(tradeUrl: string): string | null {
    const steamId64 = steamIdFromTradeUrl(tradeUrl);
    return steamId64 ? `https://steamcommunity.com/profiles/${steamId64}` : null;
}

const BUTTON_CSS = `
.vsi-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 10px 0;
    padding: 0 12px;
    box-sizing: border-box;
    width: 100%;
}
.vsi-trade-row {
    display: flex;
    gap: 8px;
    margin: 0;
    width: 100%;
    box-sizing: border-box;
}
/* No entrance animation — the row appears in place, never slides/fades in. */
.vsi-trade-row > .vsi-trade-btn { min-width: 0; flex: 1 1 0; }
.vsi-trade-row > .vsi-trade-main { flex: 5 1 0; }
.vsi-trade-row > .vsi-trade-profile { flex: 3 1 0; }
.vsi-trade-row > .vsi-trade-btn:only-child { flex: 1 1 100%; }
.vsi-inv-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px 10px 12px;
    border-radius: 8px;
    font-family: var(--font-primary, "gg sans"), sans-serif;
    /* Self-contained dark widget: opaque so it stays readable on ANY profile
       theme (light or dark Nitro gradients) — never blends into the popout. */
    background: rgba(25, 26, 28, 0.94);
    border: 1px solid rgba(255,255,255,.08);
    color: #dbdee1;
    line-height: 1.25;
    user-select: none;
    cursor: default;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 2px 8px rgba(0,0,0,.35);
}
.vsi-inv-card .vsi-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    color: #b5bac1;
    text-transform: uppercase;
    margin-bottom: 6px;
}
.vsi-inv-card .vsi-card-header .vsi-refresh {
    display: inline-block;
    cursor: pointer;
    opacity: 0.55;
    font-size: 13px;
    padding: 1px 5px;
    border-radius: 4px;
    transition: opacity .12s ease, background .12s ease, color .12s ease;
    line-height: 1;
    transform-origin: 50% 50%;
    color: #b5bac1;
    text-transform: none;
    letter-spacing: 0;
    user-select: none;
}
.vsi-inv-card .vsi-card-header .vsi-refresh:hover { opacity: 1; background: rgba(255,255,255,.08); color: #f2f3f5; }
.vsi-inv-card .vsi-card-header .vsi-refresh:active { background: rgba(88,101,242,.25); }
.vsi-inv-card.loading .vsi-refresh {
    animation: vsi-spin 0.9s linear infinite;
    opacity: 1;
    color: var(--brand-500, #5865F2);
    pointer-events: none;
}
@keyframes vsi-spin { to { transform: rotate(360deg); } }

.vsi-inv-card .vsi-value-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
}
.vsi-inv-card .vsi-value {
    font-size: 18px;
    font-weight: 800;
    color: #f2f3f5;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
}
.vsi-inv-card .vsi-delta {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
}
.vsi-inv-card .vsi-delta.up { color: #4ade80; background: rgba(35,165,90,.15); }
.vsi-inv-card .vsi-delta.down { color: #f87171; background: rgba(242,63,67,.15); }
.vsi-inv-card .vsi-spark {
    display: block;
    width: 100%;
    aspect-ratio: 240 / 30;
    height: auto;
    /* extra top/bottom margin so the endpoint + ATH/ATL dots (which overflow the box) don't crowd
       the value row above or the meta line below */
    margin: 7px 0 12px;
    overflow: visible;
}
.vsi-inv-card .vsi-meta {
    font-size: 11px;
    color: #b5bac1;
    font-weight: 500;
    margin-bottom: 8px;
}
.vsi-inv-card .vsi-meta .vsi-stale-tag {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(240, 178, 42, .18);
    color: #f0b22a;
    letter-spacing: .06em;
    margin-left: 6px;
    vertical-align: 1px;
}
.vsi-inv-card .vsi-top-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 6px;
    border-top: 1px solid rgba(255,255,255,.05);
}
.vsi-inv-card .vsi-top-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    font-weight: 500;
}
.vsi-inv-card .vsi-top-row .vsi-top-name {
    color: #dbdee1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}
/* Rarity dot before a top-item name — the item's CS2 grade color (consumer→covert→contraband). */
.vsi-inv-card .vsi-top-row .vsi-rdot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: 1px;
    flex: none;
    box-shadow: 0 0 0 1px rgba(0,0,0,.35);
}
/* Rank + milestone flex chips under the value */
.vsi-inv-card .vsi-chips { display: flex; gap: 6px; margin: 0 0 8px; flex-wrap: wrap; }
.vsi-inv-card .vsi-chip {
    font-size: 10px; font-weight: 700; letter-spacing: .02em;
    padding: 2px 7px; border-radius: 999px; line-height: 1.35;
    font-variant-numeric: tabular-nums; white-space: nowrap;
}
.vsi-inv-card .vsi-chip.rank { color: #c9d1e6; background: rgba(120,140,220,.16); }
.vsi-inv-card .vsi-chip.rank.top { color: #ffe08a; background: rgba(230,184,0,.16); }
.vsi-inv-card .vsi-chip.club { color: #7ee0c0; background: rgba(87,194,160,.16); }
.vsi-inv-card .vsi-top-row .vsi-top-price {
    color: #f2f3f5;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.vsi-inv-card .vsi-empty {
    font-size: 11.5px;
    color: #b5bac1;
    padding: 4px 0 2px 0;
    text-align: center;
    font-style: italic;
}
.vsi-inv-card.stale { opacity: 0.85; }

/* Empty-state "Load inventory" button */
.vsi-inv-card .vsi-load-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 6px;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: #5865F2;
    color: #fff;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s ease, transform .1s ease;
}
.vsi-inv-card .vsi-load-btn:hover { background: #4752C4; }
.vsi-inv-card .vsi-load-btn:active { transform: translateY(1px); }
.vsi-inv-card .vsi-load-btn svg { flex-shrink: 0; }
.vsi-inv-card.loading .vsi-load-btn { opacity: .6; pointer-events: none; }

/* Loading skeleton */
.vsi-skel {
    background: linear-gradient(90deg,
        rgba(255,255,255,.06) 0%,
        rgba(255,255,255,.12) 50%,
        rgba(255,255,255,.06) 100%);
    background-size: 200% 100%;
    animation: vsi-shimmer 1.4s ease-in-out infinite;
    border-radius: 4px;
    display: inline-block;
}
@keyframes vsi-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}
.vsi-skel-value { width: 90px; height: 20px; }
.vsi-skel-meta  { width: 140px; height: 11px; margin-top: 6px; }
.vsi-skel-row   { width: 100%; height: 14px; margin: 3px 0; opacity: .8; }

.vsi-trade-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    box-sizing: border-box;
    padding: 8px 12px;
    border-radius: 8px;
    font-family: var(--font-primary, "gg sans"), sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1;
    text-decoration: none !important;
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
    transition: transform .15s cubic-bezier(.4,.14,.3,1), box-shadow .15s ease, background .15s ease, filter .15s ease, border-color .15s ease;
    -webkit-app-region: no-drag;
    white-space: nowrap;
    box-shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 1px 2px rgba(0,0,0,.18);
}
.vsi-trade-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 1px 0 rgba(255,255,255,.11) inset, 0 5px 14px rgba(0,0,0,.28);
}
.vsi-trade-btn:active {
    transform: translateY(0);
    box-shadow: 0 1px 0 rgba(255,255,255,.05) inset, 0 1px 2px rgba(0,0,0,.18);
    filter: brightness(.94);
}
.vsi-trade-btn svg { transition: transform .15s ease; }
.vsi-trade-btn:hover svg { transform: scale(1.06); }

.vsi-trade-main { flex: 5 1 0; }
.vsi-trade-profile { flex: 3 1 0; }
.vsi-trade-btn:hover { transform: translateY(-1px); }
.vsi-trade-btn:active { transform: translateY(0); filter: brightness(.92); }
.vsi-trade-btn svg { flex-shrink: 0; }

.vsi-trade-btn.blurple { background: #5865F2; color: #fff; box-shadow: 0 2px 10px rgba(88,101,242,.35); }
.vsi-trade-btn.blurple:hover { background: #4752C4; box-shadow: 0 4px 14px rgba(88,101,242,.5); }

.vsi-trade-btn.green { background: #23A55A; color: #fff; box-shadow: 0 2px 10px rgba(35,165,90,.35); }
.vsi-trade-btn.green:hover { background: #1A8146; box-shadow: 0 4px 14px rgba(35,165,90,.5); }

.vsi-trade-btn.steam {
    background: linear-gradient(135deg, #1b2838 0%, #2a475e 55%, #3b8ac4 120%);
    color: #f5faff;
    border-color: rgba(102,192,244,.35);
    box-shadow: 0 2px 12px rgba(27,40,56,.55), inset 0 1px 0 rgba(255,255,255,.06);
}
.vsi-trade-btn.steam:hover {
    background: linear-gradient(135deg, #2a475e 0%, #3a6a8f 55%, #66c0f4 120%);
    box-shadow: 0 4px 18px rgba(102,192,244,.45), inset 0 1px 0 rgba(255,255,255,.08);
}

.vsi-trade-btn.dark {
    background: #111214;
    color: #f2f3f5;
    border-color: rgba(255,255,255,.06);
    box-shadow: 0 2px 10px rgba(0,0,0,.5);
}
.vsi-trade-btn.dark:hover { background: #1e1f22; border-color: rgba(255,255,255,.14); }

.vsi-trade-btn.auto {
    background: var(--brand-500, #5865F2);
    color: var(--white-500, #fff);
    box-shadow: 0 2px 10px color-mix(in srgb, var(--brand-500, #5865F2) 40%, transparent);
}
.vsi-trade-btn.auto:hover { background: var(--brand-600, #4752C4); }

/* Card is clickable to open the full breakdown */
.vsi-inv-card:not(.loading) { cursor: pointer; }
.vsi-inv-card:not(.loading):hover { border-color: rgba(255,255,255,.16); }

/* "What changed since last time" line */
.vsi-diff {
    margin-top: 7px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.05);
    font-size: 11px; line-height: 1.4; color: #949ba4;
}

/* ── Full breakdown modal ── */
.vsi-modal-backdrop {
    position: fixed; inset: 0; z-index: 100000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.6); backdrop-filter: blur(2px);
    animation: vsi-fade .12s ease;
}
@keyframes vsi-fade { from { opacity: 0; } to { opacity: 1; } }
.vsi-modal {
    display: flex; flex-direction: column;
    width: min(560px, 92vw); max-height: 82vh;
    background: #1a1b1e; color: #dbdee1;
    border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.6); overflow: hidden;
}
.vsi-modal-head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.06);
}
.vsi-modal-title { font-size: 15px; font-weight: 700; color: #f2f3f5; flex: 1; min-width: 0; }
.vsi-modal-title b { color: #fff; }
.vsi-modal-total { font-variant-numeric: tabular-nums; font-weight: 700; color: #fff; }
.vsi-modal-x {
    cursor: pointer; border: 0; background: transparent; color: #b5bac1;
    font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px;
}
.vsi-modal-x:hover { background: rgba(255,255,255,.08); color: #fff; }
.vsi-modal-tools { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,.06); }
.vsi-modal-search {
    flex: 1; min-width: 0; padding: 7px 10px; border-radius: 7px;
    background: #111214; color: #dbdee1; border: 1px solid rgba(255,255,255,.08); font-size: 13px;
}
.vsi-modal-search::placeholder { color: #72767d; }
.vsi-modal-sort {
    cursor: pointer; padding: 7px 12px; border-radius: 7px; font-size: 12px; font-weight: 600;
    background: #111214; color: #b5bac1; border: 1px solid rgba(255,255,255,.08); white-space: nowrap;
}
.vsi-modal-sort:hover { color: #fff; border-color: rgba(255,255,255,.16); }
.vsi-modal-list { overflow-y: auto; padding: 6px 8px 10px; }
.vsi-modal-row {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 8px; border-radius: 8px;
    border-left: 3px solid transparent; /* rarity accent */
    text-decoration: none; color: inherit; cursor: pointer;
}
.vsi-modal-row:hover { background: rgba(255,255,255,.04); }
.vsi-modal-row:hover .vsi-modal-name { color: #fff; }
.vsi-modal-row .vsi-modal-ext { opacity: 0; font-size: 11px; color: #949ba4; flex: none; transition: opacity .1s ease; }
.vsi-modal-row:hover .vsi-modal-ext { opacity: .7; }
/* StatTrak / Souvenir tag on a modal row */
.vsi-modal-tag {
    font-size: 9px; font-weight: 800; letter-spacing: .04em; flex: none;
    padding: 2px 5px; border-radius: 4px; white-space: nowrap;
}
.vsi-modal-tag.st { color: #ff9b63; background: rgba(207,106,50,.16); }
.vsi-modal-tag.sv { color: #ffd76a; background: rgba(230,184,0,.14); }
/* Exterior/wear tag, green (FN) → red (BS) */
.vsi-modal-wear { font-size: 9px; font-weight: 800; letter-spacing: .04em; flex: none; padding: 2px 5px; border-radius: 4px; white-space: nowrap; }
.vsi-modal-wear.fn { color: #4ade80; background: rgba(74,222,128,.14); }
.vsi-modal-wear.mw { color: #a3e635; background: rgba(163,230,53,.14); }
.vsi-modal-wear.ft { color: #facc15; background: rgba(250,204,21,.14); }
.vsi-modal-wear.ww { color: #fb923c; background: rgba(251,146,60,.14); }
.vsi-modal-wear.bs { color: #f87171; background: rgba(248,113,113,.14); }
/* Quiet spec cluster: wear · float · seed grouped together as one tidy unit (kept subtle so the
   colored highlight pills, not the routine numbers, are what catch the eye). */
.vsi-modal-spec { display: inline-flex; align-items: center; gap: 7px; flex: none; }
.vsi-modal-pills { display: inline-flex; align-items: center; gap: 5px; flex: none; }
/* Real float + paint seed — plain muted mono text (no pill), the # prefix keeps the seed distinct. */
.vsi-modal-float, .vsi-modal-seed { font-size: 11px; font-weight: 600; flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
.vsi-modal-float { color: #99a9c4; }
.vsi-modal-seed { color: #8f86b0; }
/* FloatDB low/high-float rank flag */
.vsi-modal-frank { font-size: 9px; font-weight: 800; letter-spacing: .03em; flex: none; white-space: nowrap; padding: 2px 5px; border-radius: 4px; }
.vsi-modal-frank.low { color: #ffe08a; background: rgba(230,184,0,.16); }
.vsi-modal-frank.high { color: #9db4d0; background: rgba(120,150,190,.16); }
/* Fade % and Blue Gem % chips (derived from the paint seed) */
.vsi-modal-fade { font-size: 10px; font-weight: 800; flex: none; white-space: nowrap; padding: 2px 6px; border-radius: 4px; color: #ffb060; background: rgba(255,140,50,.15); }
.vsi-modal-blue { font-size: 10px; font-weight: 800; flex: none; white-space: nowrap; padding: 2px 6px; border-radius: 4px; color: #6fb0ff; background: rgba(90,160,255,.17); }
/* Row right-click action menu */
.vsi-ctx {
    position: fixed; z-index: 100002; min-width: 180px; padding: 5px;
    background: #111318; border: 1px solid rgba(255,255,255,.08); border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0,0,0,.55); font-size: 13px; color: #dbdee1;
}
.vsi-ctx-item { padding: 7px 10px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.vsi-ctx-item:hover { background: #5865f2; color: #fff; }
/* Custom name tag */
.vsi-modal-nametag { font-style: italic; color: #c8a2ff; font-weight: 500; }
/* Type-filter chips */
.vsi-modal-filters { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 10px; }
.vsi-modal-filters:empty { display: none; }
.vsi-modal-chip {
    cursor: pointer; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    background: #111214; color: #b5bac1; border: 1px solid rgba(255,255,255,.08); white-space: nowrap;
}
.vsi-modal-chip:hover { color: #fff; border-color: rgba(255,255,255,.18); }
.vsi-modal-chip.active { background: #5865F2; color: #fff; border-color: transparent; }
.vsi-modal-thumb {
    width: 44px; height: 34px; flex: none; object-fit: contain;
    background: rgba(255,255,255,.03); border-radius: 5px;
}
.vsi-modal-name { flex: 1; min-width: 0; font-size: 13px; color: #dbdee1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsi-modal-qty { font-size: 11px; color: #949ba4; flex: none; }
.vsi-modal-sticker {
    font-size: 10px; font-weight: 600; flex: none; padding: 2px 6px; border-radius: 5px;
    color: #57c2a0; background: rgba(87,194,160,.12); white-space: nowrap;
}
.vsi-modal-sticker.grail { color: #e6b800; background: rgba(230,184,0,.14); }
.vsi-modal-price { font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 600; color: #f2f3f5; flex: none; }
.vsi-modal-empty { padding: 28px 16px; text-align: center; color: #949ba4; font-size: 13px; }

/* ── "Made by reap" about block in settings ── */
.vsi-about {
    margin: 0 0 18px; padding: 14px 16px; border-radius: 10px;
    background: linear-gradient(135deg, rgba(88,101,242,.14), rgba(35,165,90,.08));
    border: 1px solid rgba(255,255,255,.08);
    font-family: var(--font-primary, "gg sans"), sans-serif;
}
.vsi-about-head { display: flex; align-items: center; gap: 11px; margin-bottom: 11px; }
.vsi-about-logo { font-size: 22px; line-height: 1; }
.vsi-about-title { font-size: 15px; font-weight: 800; color: var(--header-primary, #f2f3f5); letter-spacing: -.01em; }
.vsi-about-by { font-size: 12px; color: var(--text-muted, #b5bac1); }
.vsi-about-by b { color: #c8a2ff; }
.vsi-about-links { display: flex; flex-wrap: wrap; gap: 8px; }
.vsi-about-link {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12.5px; font-weight: 600; text-decoration: none !important; cursor: pointer;
    padding: 6px 11px; border-radius: 7px;
    background: rgba(0,0,0,.22); color: #dbdee1; border: 1px solid rgba(255,255,255,.06);
    transition: background .12s ease, border-color .12s ease, transform .1s ease;
}
.vsi-about-link:hover { background: rgba(0,0,0,.35); border-color: rgba(255,255,255,.16); color: #fff; }
.vsi-about-link:active { transform: translateY(1px); }
.vsi-about-donate { background: rgba(230,184,0,.14); border-color: rgba(230,184,0,.25); color: #ffdf7e; }
.vsi-about-donate:hover { background: rgba(230,184,0,.22); border-color: rgba(230,184,0,.4); color: #ffe9a8; }
`;

let styleEl: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;

function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.id = "vsi-styles";
    styleEl.textContent = BUTTON_CSS;
    document.head.appendChild(styleEl);
}

function buildButton(shownUserId: string, isOwn: boolean, wantTradeRow: boolean, wantCard: boolean): HTMLElement {
    const theme = settings.store.buttonTheme || "blurple";
    const wrap = document.createElement("div");
    wrap.className = "vsi-wrap";
    wrap.dataset.vsi = "1";
    wrap.dataset.vsiUser = shownUserId;

    if (wantTradeRow) {
        const row = document.createElement("div");
        row.className = "vsi-trade-row";

        const trade = document.createElement("a");
        trade.className = `vsi-trade-btn ${theme} vsi-trade-main`;
        trade.href = settings.store.tradeUrl;
        trade.target = "_blank";
        trade.rel = "noopener noreferrer";
        trade.innerHTML = `${STEAM_ICON_SVG}<span>Send Trade Offer</span>`;
        row.appendChild(trade);

        const profileUrl = deriveSteamProfileUrl(settings.store.tradeUrl);
        if (profileUrl) {
            const prof = document.createElement("a");
            prof.className = `vsi-trade-btn ${theme} vsi-trade-profile`;
            prof.href = profileUrl;
            prof.target = "_blank";
            prof.rel = "noopener noreferrer";
            prof.title = "Open Steam profile";
            prof.innerHTML = `${USER_ICON_SVG}<span>Steam</span>`;
            row.appendChild(prof);
        }
        wrap.appendChild(row);
    }

    if (wantCard) {
        const card = document.createElement("div");
        card.className = "vsi-inv-card";
        card.dataset.vsiBadge = "1";

        // Instant path: if the profile + a local snapshot are already in memory, render the final
        // card synchronously — no loading skeleton, no flash. Otherwise show the skeleton and
        // resolve asynchronously.
        const steamIdSync = getSteamIdSync(shownUserId);
        const snapsSync = steamIdSync ? getSnapshotsSync(steamIdSync) : [];
        if (steamIdSync && snapsSync[0]) {
            renderPricedCard(card, snapsSync[0], snapsSync.slice(1), buildDiffLineSync(steamIdSync));
            maybeAutoRefresh(card, snapsSync[0], shownUserId, isOwn);
        } else {
            card.classList.add("loading");
            card.innerHTML = `
                <div class="vsi-card-header">
                    <span>💼 CS2 Inventory</span>
                    <span class="vsi-refresh" title="Loading…">↻</span>
                </div>
                <div class="vsi-value-row"><span class="vsi-skel vsi-skel-value"></span></div>
                <div class="vsi-skel vsi-skel-meta"></div>
                <div class="vsi-top-list">
                    <span class="vsi-skel vsi-skel-row"></span>
                    <span class="vsi-skel vsi-skel-row"></span>
                    <span class="vsi-skel vsi-skel-row"></span>
                </div>
            `;
            populateInventoryCard(card, shownUserId, isOwn).catch(e => console.error("[VSI] populateInventoryCard", e));
        }

        // Delegate refresh / load clicks at the card level so innerHTML rewrites don't kill the handler.
        card.addEventListener("click", e => {
            const t = e.target as HTMLElement | null;
            if (t?.closest?.(".vsi-refresh, .vsi-load-btn")) {
                e.stopPropagation();
                e.preventDefault();
                refreshCard(card, shownUserId, isOwn);
                return;
            }
            // Anywhere else on a priced card → open the full breakdown modal.
            if (!card.querySelector(".vsi-value")) return; // not priced yet, nothing to expand
            e.stopPropagation();
            openInventoryModalForUser(shownUserId).catch(err => console.error("[VSI] open modal", err));
        });
        wrap.appendChild(card);
    }

    return wrap;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

// Runs the same pricing pipeline as /inventory for a Discord user id, then persists a snapshot.
async function runInventoryForUser(shownUserId: string, onBackgroundUpdate?: () => void): Promise<void> {
    const steamId = await getSteamId(shownUserId);
    if (!steamId) throw new Error("no-steam");
    const name = UserStore?.getUser?.(shownUserId)?.username;
    await priceSteamId(steamId, name, onBackgroundUpdate);
}

// Prices a SteamID directly, persists the snapshot + full item list, shares to the cache, and
// returns the result. `onBackgroundUpdate` (when given) runs the slow Steam fallback in the
// background and fires once it lands. Used by the card, the modal, and the context menu.
async function priceSteamId(steamId: string, name?: string, onBackgroundUpdate?: () => void, noLiveFallback = false): Promise<InventoryResult> {
    const validSources = new Set(["csfloat", "skinport", "live_steam"]);
    const stored = settings.store.priceSource as string;
    const source = validSources.has(stored) ? stored : "csfloat";
    // The scheduled background refresh skips the slow per-item Steam fallback to stay light.
    const useLiveFallback = !noLiveFallback && !!settings.store.useLiveSteamFallback;
    const cur = settings.store.marketCurrency || 1;

    const snapFrom = (r: InventoryResult): Snapshot => ({
        total: r.total, priced: r.priced, itemCount: r.count, marketableCount: r.marketableCount,
        uniqueNames: r.uniqueNames, ts: Date.now(), source, currency: cur, topItems: r.topItems, stickerTotal: r.stickerTotal,
    });
    const saveItems = (r: InventoryResult) =>
        pushItemsSnap(steamId, { ts: Date.now(), currency: cur, total: r.total, items: r.allItems, owned: r.owned }).catch(() => { /* */ });

    // When the background Steam fallback finishes, persist the fuller total, share it, notify.
    // Push to the cache first so the returned rank/tracked ride on the stored snapshot.
    const onUpdate = onBackgroundUpdate
        ? (final: InventoryResult) => {
            const s = snapFrom(final);
            cachePushInventory(steamId, s, name).then(rk => {
                if (rk) { s.rank = rk.rank; s.tracked = rk.tracked; }
                return pushSnapshot(steamId, s);
            }).then(() => { saveItems(final); onBackgroundUpdate(); }).catch(() => { /* */ });
        }
        : undefined;

    const inv = await loadInventory(steamId, { source, useLiveFallback, onUpdate });
    if (inv.isPrivate) throw new Error("inventory-private");
    const snap = snapFrom(inv);
    const rk = await cachePushInventory(steamId, snap, name); // share to the read-through cache (best-effort)
    if (rk) { snap.rank = rk.rank; snap.tracked = rk.tracked; }
    await pushSnapshot(steamId, snap);
    await saveItems(inv);
    return inv;
}

async function refreshCard(card: HTMLElement, shownUserId: string, isOwn: boolean) {
    if (card.classList.contains("loading")) return; // already refreshing
    card.classList.add("loading");
    const refresh = card.querySelector<HTMLElement>(".vsi-refresh");
    const originalTitle = refresh?.title;
    if (refresh) refresh.title = "Refreshing…";
    try {
        // The background Steam-fallback callback re-renders the card in place once the slow
        // per-item prices land, so the card shows the CSFloat total instantly and fills in after.
        await runInventoryForUser(shownUserId, () => {
            if (card.isConnected) populateInventoryCard(card, shownUserId, isOwn).catch(() => { /* */ });
        });
    } catch (e: any) {
        console.error("[VSI] refresh failed", e);
        if (e?.message === "no-steam") {
            card.innerHTML = `
                <div class="vsi-card-header"><span>💼 CS2 Inventory</span></div>
                <div class="vsi-empty">No visible Steam account on this profile.</div>
            `;
            card.classList.remove("loading");
            return;
        }
        if (e?.message === "inventory-private") {
            card.innerHTML = `
                <div class="vsi-card-header"><span>💼 CS2 Inventory</span><span class="vsi-refresh" title="Try again">↻</span></div>
                <div class="vsi-empty">Steam inventory is private.</div>
            `;
            card.classList.remove("loading");
            const r = card.querySelector<HTMLElement>(".vsi-refresh");
            if (r) r.addEventListener("click", () => refreshCard(card, shownUserId, isOwn));
            return;
        }
        // Generic failure — restore title, drop loading
        if (refresh && originalTitle) refresh.title = originalTitle;
    }
    card.classList.remove("loading");
    await populateInventoryCard(card, shownUserId, isOwn);
}

async function populateInventoryCard(card: HTMLElement, shownUserId: string, isOwn: boolean) {
    card.classList.remove("loading");
    const steamId = await getSteamId(shownUserId);
    if (!steamId) {
        card.innerHTML = `
            <div class="vsi-card-header"><span>💼 CS2 Inventory</span></div>
            <div class="vsi-empty">No visible Steam account on this profile.</div>
        `;
        return;
    }
    const snaps = await getSnapshots(steamId);
    let latest = snaps[0];
    if (!latest) {
        // No local snapshot — someone else may have already priced this profile. Check the
        // shared cache: a hit renders instantly (and we keep a local copy for next time).
        const cached = await cacheGetInventory(steamId, settings.store.marketCurrency || 1);
        if (cached) {
            latest = cached;
            pushSnapshot(steamId, cached).catch(() => { /* */ });
        }
    }
    if (!latest) {
        const who = isOwn ? "your" : "their";
        card.innerHTML = `
            <div class="vsi-card-header"><span>💼 CS2 Inventory</span></div>
            <div class="vsi-empty">No snapshot yet — load ${who} CS2 inventory to price it.</div>
            <button class="vsi-load-btn" type="button">${STEAM_ICON_SVG}<span>Load inventory</span></button>
        `;
        return;
    }

    const history = snaps[0] === latest ? snaps.slice(1) : snaps;
    renderPricedCard(card, latest, history, await buildDiffLine(steamId));
    maybeAutoRefresh(card, latest, shownUserId, isOwn);
}

// Minimal price-history sparkline from a value series: gradient area fill, a crisp trend-colored
// line, and a glowing endpoint dot. Green if the series rose overall, red if it fell.
let sparkSeq = 0;
function sparklineSvg(values: number[], cur = 1): string {
    if (values.length < 2) return "";
    const W = 240, H = 30, px = 4, py = 6;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const n = values.length;
    const X = (i: number) => px + (i / (n - 1)) * (W - 2 * px);
    const Y = (v: number) => H - py - ((v - min) / range) * (H - 2 * py);
    const line = "M" + values.map((v, i) => `${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" L");
    const area = `${line} L${X(n - 1).toFixed(1)} ${H} L${X(0).toFixed(1)} ${H} Z`;
    const first = values[0], last = values[n - 1];
    const color = last > first ? "#4ade80" : last < first ? "#f87171" : "#8b8f96";
    const id = `vsg${sparkSeq++}`;
    const lx = X(n - 1).toFixed(1), ly = Y(last).toFixed(1);

    // All-time high / low markers: small hollow rings on the peak and trough of the series, with a
    // hover tooltip. Skipped when they'd land on the (already-dotted) latest point, or when the
    // series is flat / too short to have a meaningful extreme.
    let markers = "";
    if (n >= 3 && max > min) {
        const ring = (i: number, col: string, label: string) => (i === n - 1) ? ""
            : `<circle cx="${X(i).toFixed(1)}" cy="${Y(values[i]).toFixed(1)}" r="2.3" fill="#191a1c" stroke="${col}" stroke-width="1.3" vector-effect="non-scaling-stroke" opacity="0.9"><title>${label} ${fmt(values[i], cur)}</title></circle>`;
        markers = ring(values.indexOf(max), "#4ade80", "High") + ring(values.indexOf(min), "#f87171", "Low");
    }

    return `<svg class="vsi-spark" viewBox="0 0 ${W} ${H}">`
        + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${color}" stop-opacity="0.28"/>`
        + `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`
        + `<path d="${area}" fill="url(#${id})"/>`
        + `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`
        + markers
        + `<circle cx="${lx}" cy="${ly}" r="3.4" fill="${color}" opacity="0.22"/>`
        + `<circle cx="${lx}" cy="${ly}" r="1.7" fill="${color}"/></svg>`;
}

// If auto-refresh is on and this snapshot is stale, silently re-price in the background and let
// the refresh update the card in place. No loop: a successful re-price stamps a fresh ts.
function maybeAutoRefresh(card: HTMLElement, latest: Snapshot, shownUserId: string, isOwn: boolean) {
    if (!settings.store.autoRefreshStale || card.classList.contains("loading")) return;
    // 0 = "never mark stale" everywhere → also means never auto-refresh (nothing is stale).
    const staleH = settings.store.snapshotStalenessHours ?? 24;
    if (staleH <= 0 || Date.now() - latest.ts <= staleH * 3_600_000) return;
    refreshCard(card, shownUserId, isOwn).catch(() => { /* */ });
}

// ─── Scheduled background refresh ───────────────────────────────────────────────
// Re-prices recently-viewed profiles on a timer so every tracked card has a real data point at the
// delta window (a true, consistent 24h change). Deliberately light: it checks every 30 min and
// prices only a few STALE profiles per check (spaced out), so at steady state each profile is
// re-priced ~every 6h with no continuous CPU use. Profiles you haven't viewed in a week age out.
let bgTimer: ReturnType<typeof setInterval> | null = null;
let bgSeedTimer: ReturnType<typeof setTimeout> | null = null;
let bgRunning = false;
const BG_CHECK_INTERVAL = 15 * 60_000;      // how often to look for stale profiles
const BG_RELEVANT_MS = 7 * 24 * 3_600_000;  // stop re-pricing profiles not viewed in this long
const BG_MAX_PER_TICK = 5;                  // cap price fetches per check so it never bursts

// How stale a profile must be before we re-price it — tied to the delta window so the cadence
// always supports it: a 1h window prices hourly, longer windows cap at every 6h (dense enough for
// a 24h/7d point without over-pricing). No separate setting to keep in sync.
function bgStaleMs(): number {
    const windowMin = settings.store.deltaMinAgeMinutes || 1440;
    return Math.min(windowMin * 60_000, 6 * 3_600_000);
}

// SteamIDs we hold snapshots for (i.e. profiles that have been priced at least once).
function trackedSteamIds(): string[] {
    try {
        const fs = require("fs");
        const folder = (BD as any).Plugins?.folder;
        const cfg = folder ? `${folder}/${PLUGIN_NAME}.config.json` : null;
        if (!cfg || !fs.existsSync(cfg)) return [];
        const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
        return Object.keys(data).filter(k => k.startsWith("vsi.snap.")).map(k => k.slice("vsi.snap.".length));
    } catch { return []; }
}

async function backgroundTick() {
    if (settings.store.backgroundRefresh === false || bgRunning) return;
    bgRunning = true;
    try {
        const now = Date.now();
        const staleMs = bgStaleMs();
        const stale = trackedSteamIds()
            .map(steamId => ({ steamId, age: now - (getSnapshotsSync(steamId)[0]?.ts ?? 0) }))
            .filter(x => x.age > staleMs && x.age < BG_RELEVANT_MS)
            .sort((a, b) => b.age - a.age)     // most stale first
            .slice(0, BG_MAX_PER_TICK);
        for (const { steamId } of stale) {
            try { await priceSteamId(steamId, undefined, undefined, true); } // no name, no callback, skip live fallback
            catch { /* private / transient — skip, try again next cycle */ }
            await sleep(3000); // gentle spacing between profiles
        }
    } finally { bgRunning = false; }
}

function startBackgroundRefresh() {
    if (bgTimer) return;
    bgTimer = setInterval(() => { backgroundTick().catch(() => { /* */ }); }, BG_CHECK_INTERVAL);
    bgSeedTimer = setTimeout(() => { backgroundTick().catch(() => { /* */ }); }, 90_000); // first pass ~90s after load
}

function stopBackgroundRefresh() {
    if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
    if (bgSeedTimer) { clearTimeout(bgSeedTimer); bgSeedTimer = null; }
}

// ── Self-updater ────────────────────────────────────────────────────────────────
// Checks the built plugin committed on `main` for a newer @version, and (on confirm) writes it over
// the local file — BetterDiscord's file watcher then reloads the plugin. No manual re-download.
const UPDATE_URL = "https://raw.githubusercontent.com/VisaHolder/cs2-inventory-betterdiscord/main/betterdiscord/CS2Inventory.plugin.js";
function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(n => parseInt(n, 10) || 0);
    const pb = b.split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    return 0;
}
function installUpdate(remote: string, content: string) {
    try {
        const folder = (BD as any).Plugins?.folder;
        if (!folder) throw new Error("no plugins folder");
        require("fs").writeFileSync(`${folder}/${PLUGIN_NAME}.plugin.js`, content);
        try { BD.UI?.showToast?.(`Updated to v${remote} — reloading…`, { type: "success" }); } catch { /* */ }
    } catch (e) {
        console.error("[VSI] update install failed", e);
        try { BD.UI?.showToast?.("Update failed — grab it from the GitHub releases page.", { type: "error" }); } catch { /* */ }
    }
}
async function checkForUpdate() {
    if (settings.store.autoUpdateCheck === false) return;
    const local = (BD as any).Plugins?.get?.(PLUGIN_NAME)?.version;
    if (!local) return; // can't determine our own version → don't risk a false prompt
    let content: string;
    try { content = await fetchText(UPDATE_URL); } catch { return; } // offline / rate-limited → silently skip
    const remote = content.match(/@version\s+([\d.]+)/)?.[1];
    if (!remote || compareVersions(remote, local) <= 0) return; // up to date
    try {
        BD.UI.showConfirmationModal(
            "CS2 Inventory — update available",
            `Version ${remote} is out (you have ${local}). Update now and it reloads itself — no manual download needed.`,
            { confirmText: "Update now", cancelText: "Later", onConfirm: () => installUpdate(remote, content) },
        );
    } catch (e) { console.error("[VSI] update prompt", e); }
}

// First-load nudge: if no Steam token is set yet, show a one-time notice with a link to grab it
// (unlocks your own full inventory — trade-held gloves/knives — and exact floats). Optional; other
// people's floats work without it. Suppressed once the user sets a token or clicks "Don't ask again".
const TOKEN_URL = "https://steamcommunity.com/pointssummary/ajaxgetasyncconfig";
function maybePromptToken() {
    try {
        if ((settings.store.steamWebApiToken || "").trim()) return;
        if (BD.Data.load(PLUGIN_NAME, "vsi.tokenPromptDone")) return;
        if (!BD.UI?.showNotice) return;
        const close = BD.UI.showNotice(
            "CS2 Inventory: add a free Steam token to show YOUR full inventory (trade-held gloves & knives) + exact floats. Paste it into the plugin's Steam Web Api Token setting.",
            {
                type: "info",
                buttons: [
                    { label: "Get my token", onClick: () => openProtocol(TOKEN_URL) },
                    { label: "Don't ask again", onClick: () => { try { BD.Data.save(PLUGIN_NAME, "vsi.tokenPromptDone", true); } catch { /* */ } try { close?.(); } catch { /* */ } } },
                ],
            },
        );
    } catch (e) { console.error("[VSI] token prompt", e); }
}

// A small rarity dot in the item's CS2 grade color, if we know it (hex from Steam's name_color).
function rarityDotHtml(color?: string): string {
    if (!color || !/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return "";
    return `<span class="vsi-rdot" style="background:#${color}"></span>`;
}

// Highest inventory-value milestone reached, in the card's currency (e.g. "$10K", "C$1K", "$1M").
// Empty below the first tier — no chip for sub-$1K inventories.
function milestoneLabel(total: number, cur: number): string {
    const tiers = [1_000_000, 500_000, 250_000, 100_000, 50_000, 25_000, 10_000, 5_000, 1_000];
    for (const t of tiers) if (total >= t) {
        const k = t >= 1_000_000 ? `${t / 1_000_000}M` : `${t / 1_000}K`;
        return `${currencySymbol(cur)}${k}`;
    }
    return "";
}

// Rank + milestone flex chips (gated by showFlexBadges). Rank rides on the snapshot from the
// shared cache; milestone is derived from the total. Empty string when neither applies.
function flexChipsHtml(latest: Snapshot, cur: number): string {
    if (settings.store.showFlexBadges === false) return "";
    const chips: string[] = [];
    const club = milestoneLabel(latest.total, cur);
    if (club) chips.push(`<span class="vsi-chip club" title="Inventory-value milestone">${club}</span>`);
    return chips.length ? `<div class="vsi-chips">${chips.join("")}</div>` : "";
}

// Pure, synchronous card render from a resolved snapshot (+ older history for the delta chip,
// + the already-computed diff line). Shared by the async populate and the instant sync path.
function renderPricedCard(card: HTMLElement, latest: Snapshot, history: Snapshot[], changed: string | null) {
    const cur = latest.currency || 1;
    const ageMs = Date.now() - latest.ts;
    const staleH = settings.store.snapshotStalenessHours || 0;
    // When auto-refresh is on, a stale card gets re-priced in the background, so don't bother
    // flagging it STALE — it'd just flash and vanish.
    const isStale = staleH > 0 && ageMs > staleH * 3_600_000 && !settings.store.autoRefreshStale;
    card.classList.remove("loading");
    card.classList.toggle("stale", isStale);

    let deltaHtml = "";
    if (settings.store.showPriceChange) {
        const minAgeMin = settings.store.deltaMinAgeMinutes || 1440;
        // Only diff against snapshots in the SAME currency — otherwise switching marketCurrency makes
        // the chip show the FX gap (e.g. USD total vs an old EUR snapshot), not a real value change.
        const sameCurHistory = history.filter(s => (s.currency || 1) === cur);
        const d = computeDelta(latest.total, sameCurHistory, minAgeMin * 60_000);
        if (d) {
            const cls = d.delta > 0 ? "up" : d.delta < 0 ? "down" : "";
            const sign = d.delta >= 0 ? "+" : "";
            // Fixed window label (same on every card) so the timeframe is consistent across profiles;
            // the nearest snapshot's true age is in the tooltip for anyone who wants the exact basis.
            const win = windowLabel(minAgeMin);
            deltaHtml = `<span class="vsi-delta ${cls}" title="change over the last ${win} (nearest snapshot ${d.ago})">${sign}${fmt(d.delta, cur)} · ${win}</span>`;
        }
    }

    const shortSource = latest.source === "csfloat" ? "CSFloat"
        : latest.source === "skinport" ? "Skinport"
        : latest.source === "live_steam" ? "Steam Live"
        : latest.source;

    const itemCountBit = settings.store.showItemCount
        ? ` · ${latest.marketableCount ?? latest.itemCount} items`
        : "";

    const staleTag = isStale ? "<span class=\"vsi-stale-tag\">STALE</span>" : "";

    const topItems = (latest.topItems ?? []).slice(0, settings.store.topItemsCount || 5);
    const topHtml = settings.store.compactCard
        ? ""
        : topItems.length
            ? `<div class="vsi-top-list">${topItems.map(i => `
                <div class="vsi-top-row">
                    <span class="vsi-top-name">${rarityDotHtml(i.color)}${escapeHtml(abbrevItem(i.name))}</span>
                    <span class="vsi-top-price">${fmt(i.price, cur)}</span>
                </div>
            `).join("")}</div>`
            : "<div class=\"vsi-empty\">Top items will show after next /inventory run.</div>";

    const diffHtml = changed ? `<div class="vsi-diff">${escapeHtml(changed)}</div>` : "";

    let sparkHtml = "";
    if (settings.store.showSparkline !== false) {
        // Chronological value series (oldest → newest) in the current currency only.
        const local = [...history].reverse().concat(latest).filter(s => (s.currency || 1) === cur).map(s => s.total);
        // Local history is thin on a first/foreign view — fall back to the shared value history from
        // the cache so any profile shows a real trend line immediately (ending at the current total).
        let series = local;
        if (local.length < 2 && latest.series && latest.series.length >= 2) {
            series = latest.series[latest.series.length - 1] === latest.total ? latest.series : [...latest.series, latest.total];
        }
        sparkHtml = sparklineSvg(series, cur);
    }

    card.innerHTML = `
        <div class="vsi-card-header">
            <span>💼 CS2 Inventory</span>
            <span class="vsi-refresh" title="Refresh">↻</span>
        </div>
        <div class="vsi-value-row">
            <span class="vsi-value">${fmt(latest.total, cur)}</span>
            ${deltaHtml}
        </div>
        ${flexChipsHtml(latest, cur)}
        ${sparkHtml}
        <div class="vsi-meta">${shortSource} · ${humanAgo(ageMs)}${itemCountBit}${stickerSuffix(latest.stickerTotal, cur)}${staleTag}</div>
        ${topHtml}
        ${diffHtml}
    `;
}

function panelUserId(panel: HTMLElement): string | null {
    const withId = panel.querySelector<HTMLElement>("[data-user-id]");
    if (withId?.dataset.userId) return withId.dataset.userId;
    const img = panel.querySelector<HTMLImageElement>('img[src*="/avatars/"], img[src*="/users/"]');
    if (img) {
        const m = img.src.match(/\/(?:avatars|users)\/(\d{15,25})\//);
        if (m) return m[1];
    }
    return null;
}

function findLeaf(root: HTMLElement, textRegex: RegExp): HTMLElement | null {
    const all = root.querySelectorAll<HTMLElement>("*");
    for (const el of all) {
        if (el.children.length !== 0) continue;
        if (textRegex.test((el.textContent || "").trim())) return el;
    }
    return null;
}

function containerBlock(leaf: HTMLElement, boundary: HTMLElement): HTMLElement {
    // Walk up to the biggest sibling-level block that still isn't the whole popout.
    let node: HTMLElement = leaf;
    while (node.parentElement && node.parentElement !== boundary && node.offsetHeight < 24) {
        node = node.parentElement;
    }
    while (node.parentElement && node.parentElement !== boundary && (node.parentElement.children.length === 1)) {
        node = node.parentElement;
    }
    return node;
}

// Different popout layouts drop the card into different containers: a padded section list (already
// inset) vs. the full-bleed body (edge-to-edge). When the parent provides no side padding, add the
// popout's real content inset so the card/buttons line up with the name/tags/bio instead of
// stretching wider than everything else.
function normalizeInset(wrap: HTMLElement, parent: HTMLElement, inner: HTMLElement) {
    try {
        if ((parseFloat(getComputedStyle(parent).paddingLeft) || 0) >= 8) return; // parent already insets its children
        let inset = 12; // sane default popout content inset
        const ref = inner.querySelector<HTMLElement>('[class*="nameTag"], [class*="userTag"], [class*="username"], [class*="tags_"], [class*="userInfo"], [class*="bio"]');
        if (ref) {
            const m = Math.round(ref.getBoundingClientRect().left - parent.getBoundingClientRect().left);
            if (m > 2 && m < 60) inset = m;
        }
        wrap.style.paddingLeft = `${12 + inset}px`;
        wrap.style.paddingRight = `${12 + inset}px`;
    } catch { /* leave default padding */ }
}

function findInsertionPoint(inner: HTMLElement): { parent: HTMLElement; before: Node | null } | null {
    // Priority 1: sit right above "Game Collection" section (below View Full Bio, above the section list)
    const gc = findLeaf(inner, /^Game Collection$/i);
    if (gc) {
        const block = containerBlock(gc, inner);
        if (block.parentElement) return { parent: block.parentElement, before: block };
    }
    // Priority 2: sit right below "View Full Bio"
    const vfb = findLeaf(inner, /^View Full Bio$/i);
    if (vfb) {
        const block = containerBlock(vfb, inner);
        if (block.parentElement) return { parent: block.parentElement, before: block.nextSibling };
    }
    // Priority 3: sit above Edit Profile
    const ep = [...inner.querySelectorAll<HTMLElement>("button, a")].find(b => /edit\s+profile/i.test(b.textContent || ""));
    if (ep?.parentElement) return { parent: ep.parentElement, before: ep };
    // Priority 4: above the popout's "Message @user" input (some popouts have no Game Collection / no bio)
    const msgInput = inner.querySelector<HTMLElement>('[role="textbox"], [contenteditable="true"], [class*="channelTextArea"]');
    if (msgInput) {
        let node: HTMLElement | null = msgInput;
        // Walk up to the direct child of inner
        while (node && node.parentElement && node.parentElement !== inner) node = node.parentElement;
        if (node && node.parentElement === inner) {
            return { parent: inner, before: node };
        }
    }
    // Fallback: append to inner
    return { parent: inner, before: null };
}

function tryInject(panel: HTMLElement) {
    if (panel.querySelector('[data-vsi="1"]')) return;
    const shownId = panelUserId(panel);
    if (!shownId) return;
    const myId = UserStore.getCurrentUser()?.id;
    const isOwn = shownId === myId;

    // Card visibility: your own always shows (unless Off); foreign profiles show on every linked
    // profile ("all") or only ones you've opted in via right-click ("enabled").
    const mode = (settings.store.inventoryMode as string) || "enabled";
    const wantCard = mode === "off" ? false
        : isOwn ? true
        : mode === "all" ? true
        : isCardEnabled(shownId);

    // Own-profile trade URL comes from plugin settings; foreign trade URL comes from their bio (async).
    const ownTradeUrl = isOwn ? settings.store.tradeUrl?.trim() : undefined;
    const wantTradeRow = isOwn && !!settings.store.showOnOwnProfile && !!ownTradeUrl;
    // Foreign trade row rides along with the card — only when the card is allowed for this user.
    const canRenderForeignTradeRow = !isOwn && wantCard;
    if (!wantTradeRow && !wantCard && !canRenderForeignTradeRow) return;

    const inner = panel.querySelector<HTMLElement>('[class*="inner_"]') ?? panel;
    const target = findInsertionPoint(inner);
    if (!target) return;
    const btn = buildButton(shownId, isOwn, wantTradeRow, wantCard);
    target.parent.insertBefore(btn, target.before);
    normalizeInset(btn, target.parent, inner);

    // For foreign users, resolve trade URL + Steam ID from two sources:
    // 1. Bio scrape (steamcommunity.com/tradeoffer/new/ URL in About Me)
    // 2. Discord's own Steam connection (Steam profile URL fallback)
    // Resolve synchronously from the in-memory profile first for an instant no-flash render,
    // fall back to an async fetch (with fade-in) only when the profile isn't loaded yet.
    if (!isOwn) {
        const sync = resolveForeignSync(shownId);
        if (sync && (sync.tradeUrl || sync.steamId)) {
            // Everything needed is already in memory → render the row NOW, no fetch, no animation.
            const row = buildForeignRow(sync.tradeUrl, sync.steamId);
            if (row) btn.insertBefore(row, btn.firstChild);
            // SteamID but no bio trade URL → check the shared cache in the background and quietly
            // swap in a Trade button if one is published (the Steam button never moves/re-pops).
            if (!sync.tradeUrl && sync.steamId) {
                const sid = sync.steamId;
                cacheGetTradeUrl(sid).then(tradeUrl => {
                    if (!tradeUrl || !btn.isConnected) return;
                    const existing = btn.querySelector<HTMLElement>(".vsi-trade-row");
                    const upgraded = buildForeignRow(tradeUrl, sid);
                    if (existing && upgraded) existing.replaceWith(upgraded);
                }).catch(() => { /* */ });
            }
        } else {
            // Profile not in memory yet → we must fetch. Render once when it lands (no animation).
            (async () => {
                const [bioTradeUrl, steamId] = await Promise.all([
                    getTradeUrlForUser(shownId).catch(() => null as string | null),
                    getSteamId(shownId).catch(() => null as string | null),
                ]);
                const tradeUrl = bioTradeUrl ?? (steamId ? await cacheGetTradeUrl(steamId).catch(() => null) : null);
                if ((!tradeUrl && !steamId) || !btn.isConnected || btn.querySelector(".vsi-trade-row")) return;
                const row = buildForeignRow(tradeUrl, steamId);
                if (row) btn.insertBefore(row, btn.firstChild);
            })().catch(e => console.error("[VSI] foreign row", e));
        }
    }
}

/**
 * Synchronous resolution from the already-loaded profile. Returns null (→ async path) when the
 * profile isn't in memory yet, so anything needing a network round-trip fades in when it arrives.
 */
function resolveForeignSync(shownId: string): { tradeUrl: string | null; steamId: string | null } | null {
    const profile: any = UserProfileStore.getUserProfile(shownId);
    if (!profile) return null; // not loaded yet → async

    const accounts = profile?.connectedAccounts || profile?.connected_accounts || [];
    const steamId = accounts.find((c: any) => c?.type === "steam" || c?.type === "STEAM")?.id ?? null;
    const bioText = profile?.bio ?? profile?.userProfile?.bio ?? profile?.user_profile?.bio;
    const tradeUrl = extractTradeUrl(bioText ?? null);
    if (!tradeUrl && !steamId) return null; // nothing to show — skip render entirely

    return { tradeUrl, steamId };
}

function buildForeignRow(tradeUrl: string | null, steamId: string | null): HTMLElement | null {
    const theme = settings.store.buttonTheme || "blurple";
    const row = document.createElement("div");
    row.className = "vsi-trade-row";

    if (tradeUrl) {
        const trade = document.createElement("a");
        trade.className = `vsi-trade-btn ${theme} vsi-trade-main`;
        trade.href = tradeUrl;
        trade.target = "_blank";
        trade.rel = "noopener noreferrer";
        trade.innerHTML = `${STEAM_ICON_SVG}<span>Send Trade Offer</span>`;
        row.appendChild(trade);
    }

    // Steam profile: prefer the trade URL's partner param (has the exact user), fall back to raw SteamID.
    const profileUrl = tradeUrl ? deriveSteamProfileUrl(tradeUrl)
        : steamId ? `https://steamcommunity.com/profiles/${steamId}`
        : null;

    if (profileUrl) {
        const prof = document.createElement("a");
        // If there's no trade button, the Steam button gets the wide "main" width instead of the narrow "profile" width.
        prof.className = `vsi-trade-btn ${theme} ${tradeUrl ? "vsi-trade-profile" : "vsi-trade-main"}`;
        prof.href = profileUrl;
        prof.target = "_blank";
        prof.rel = "noopener noreferrer";
        prof.title = "Open Steam profile";
        prof.innerHTML = `${USER_ICON_SVG}<span>Steam Profile</span>`;
        row.appendChild(prof);
    }

    return row.children.length ? row : null;
}

// ─── Full breakdown modal ──────────────────────────────────────────────────────
// Steam economy thumbnail. The akamai host serves the image directly (the cloudflare host 301-redirects).
const steamThumb = (icon: string) => `https://community.akamai.steamstatic.com/economy/image/${icon}/48x48`;

// The item's Steam Community Market listing page. Prefer the raw market_hash_name (hashName);
// otherwise strip the phase suffix and any " ×N" qty we appended for display.
const stripToHashName = (name: string) =>
    name.replace(/\s*×\d+\s*$/, "").replace(/\s*\((?:Phase [1-4]|Ruby|Sapphire|Black Pearl|Emerald)\)\s*$/i, "");
const steamMarketUrl = (i: PricedItem) =>
    `https://steamcommunity.com/market/listings/730/${encodeURIComponent(i.hashName ?? stripToHashName(i.name))}`;
// steam:// deep-link that opens CS2 and inspects the exact item (from asset property 6).
const inspectUrl = (payload: string) => `steam://run/730//+csgo_econ_action_preview%20${payload}`;
const hashNameOf = (i: PricedItem) => i.hashName ?? stripToHashName(i.name);
const csfloatSearchUrl = (i: PricedItem) => `https://csfloat.com/search?market_hash_name=${encodeURIComponent(hashNameOf(i))}`;
// Buff163's hash-fragment market search (same format CSFloat's own extension links to).
const buffSearchUrl = (i: PricedItem) => `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodeURIComponent(hashNameOf(i))}`;
const inventoryUrl = (assetid: string, ownerSteamId: string) =>
    `https://steamcommunity.com/profiles/${ownerSteamId}/inventory/#730_2_${assetid}`;
// The shareable inspect link (literal space, not %20) — the form you paste into CSFloat's checker.
const inspectLink = (payload: string) => `steam://run/730//+csgo_econ_action_preview ${payload}`;

// Copy text to the clipboard through whatever the Discord host exposes.
function copyText(text: string): boolean {
    try { const dn = (window as any).DiscordNative; if (dn?.clipboard?.copy) { dn.clipboard.copy(text); return true; } } catch { /* */ }
    try { const cb = require("electron")?.clipboard; if (cb?.writeText) { cb.writeText(text); return true; } } catch { /* */ }
    try { (navigator as any).clipboard?.writeText?.(text); return true; } catch { /* */ }
    return false;
}

// Every action available for a row, in menu order. A `url` opens externally; a `copy` writes to the
// clipboard. Kinds whose data is missing (no inspect payload / no assetid) are omitted.
interface RowAction { kind: string; label: string; url?: string; copy?: string }
function rowActions(i: PricedItem, ownerSteamId: string): RowAction[] {
    const out: RowAction[] = [];
    if (i.inspect) out.push({ kind: "inspect", label: "Inspect in-game", url: inspectUrl(i.inspect) });
    if (i.inspect) out.push({ kind: "copyinspect", label: "Copy inspect link", copy: inspectLink(i.inspect) });
    out.push({ kind: "csfloat", label: "Find on CSFloat", url: csfloatSearchUrl(i) });
    out.push({ kind: "buff", label: "Price on Buff163", url: buffSearchUrl(i) });
    if (i.assetid && ownerSteamId) out.push({ kind: "inventory", label: "View in owner's inventory", url: inventoryUrl(i.assetid, ownerSteamId) });
    out.push({ kind: "market", label: "Steam Market page", url: steamMarketUrl(i) });
    return out;
}
// Resolve a configured action kind to its URL for this item, falling back to Market when the
// chosen kind's data isn't available. (Only URL-kinds are ever selectable as a direct action.)
const actionUrlFor = (kind: string, i: PricedItem, ownerSteamId: string): string => {
    const acts = rowActions(i, ownerSteamId);
    return (acts.find(a => a.kind === kind && a.url) ?? acts.find(a => a.kind === "market"))!.url!;
};
// Where a LEFT-click goes, per the itemClickAction setting.
function itemHref(i: PricedItem, ownerSteamId: string): string {
    return actionUrlFor((settings.store.itemClickAction as string) || "market", i, ownerSteamId);
}
// Open a steam:// (or http) URL via the OS handler. Discord's Electron swallows a plain anchor
// click / window.open for custom protocols, so go through DiscordNative → Electron shell → anchor.
function openProtocol(url: string) {
    try { const dn = (window as any).DiscordNative; if (dn?.native?.openExternal) { dn.native.openExternal(url); return; } } catch { /* */ }
    try { const sh = require("electron")?.shell; if (sh?.openExternal) { sh.openExternal(url); return; } } catch { /* */ }
    try { const a = document.createElement("a"); a.href = url; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove(); } catch { /* */ }
}
const clickActionLabel = (i: PricedItem): string => {
    const a = (settings.store.itemClickAction as string) || "market";
    if (a === "inspect" && i.inspect) return "Inspect in-game";
    if (a === "csfloat") return "Find on CSFloat";
    if (a === "buff") return "Price on Buff163";
    if (a === "inventory" && i.assetid) return "View in owner's inventory";
    return "Open on the Steam Community Market";
};

// ── Row right-click menu ─────────────────────────────────────────────────────────
// A tiny floating menu (our own HTML rows aren't React nodes, so BdApi.ContextMenu doesn't
// fit) listing the available actions for one item. Dismisses on outside-click / Escape / scroll.
let _ctxMenuEl: HTMLElement | null = null;
function closeItemMenu() {
    if (!_ctxMenuEl) return;
    _ctxMenuEl.remove(); _ctxMenuEl = null;
    document.removeEventListener("mousedown", _ctxOutside, true);
    document.removeEventListener("keydown", _ctxKey, true);
    window.removeEventListener("scroll", closeItemMenu, true);
}
function _ctxOutside(e: MouseEvent) { if (_ctxMenuEl && !_ctxMenuEl.contains(e.target as Node)) closeItemMenu(); }
function _ctxKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); closeItemMenu(); } }
function showItemMenu(x: number, y: number, actions: RowAction[]) {
    closeItemMenu();
    const m = document.createElement("div");
    m.className = "vsi-ctx";
    m.innerHTML = actions.map(a => a.copy != null
        ? `<div class="vsi-ctx-item" data-copy="${escapeHtml(a.copy)}">${escapeHtml(a.label)}</div>`
        : `<div class="vsi-ctx-item" data-url="${escapeHtml(a.url ?? "")}">${escapeHtml(a.label)}</div>`).join("");
    document.body.appendChild(m);
    _ctxMenuEl = m;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
    m.addEventListener("click", ev => {
        const el = (ev.target as HTMLElement).closest?.(".vsi-ctx-item") as HTMLElement | null;
        if (!el) return;
        if (el.dataset.copy != null) { if (copyText(el.dataset.copy)) try { BD.UI?.showToast?.("Copied inspect link", { type: "success" }); } catch { /* */ } }
        else if (el.dataset.url) openProtocol(el.dataset.url);
        closeItemMenu();
    });
    // Defer so the opening right-click's own event doesn't immediately dismiss it.
    setTimeout(() => {
        if (!_ctxMenuEl) return;
        document.addEventListener("mousedown", _ctxOutside, true);
        document.addEventListener("keydown", _ctxKey, true);
        window.addEventListener("scroll", closeItemMenu, true);
    }, 0);
}
const rarityAccent = (rarity?: string) =>
    rarity && /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(rarity) ? ` style="border-left-color:#${rarity}"` : "";
// StatTrak / Souvenir tag from the raw market name.
const stTag = (name: string) =>
    /StatTrak™/.test(name) ? '<span class="vsi-modal-tag st">ST</span>'
    : /^Souvenir /.test(name) ? '<span class="vsi-modal-tag sv">SV</span>' : "";

// Clean display name for the breakdown: drop the wear parenthetical and the StatTrak™/Souvenir
// prefixes (both shown as their own chips) so the name isn't doubled up. Keeps ★ and phase "(Ruby)".
const modalName = (name: string): string =>
    name.replace(/StatTrak™\s*/g, "").replace(/Souvenir\s+/g, "")
        .replace(/\s*\((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)\s*$/i, "")
        .replace(/★\s*/g, "★ ").trim();

// Exterior/wear tag (FN → BS), color-graded green→red, parsed from the item name.
const WEAR_TAGS: Record<string, [string, string]> = {
    "Factory New": ["FN", "fn"], "Minimal Wear": ["MW", "mw"], "Field-Tested": ["FT", "ft"],
    "Well-Worn": ["WW", "ww"], "Battle-Scarred": ["BS", "bs"],
};
const wearTag = (name: string): string => {
    const m = name.match(/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)/);
    if (!m) return "";
    const [abbr, cls] = WEAR_TAGS[m[1]];
    return `<span class="vsi-modal-wear ${cls}">${abbr}</span>`;
};

// ── Rare-pattern intel from the paint seed ──────────────────────────────────────
// Fade % is deterministic (Step7750's calculator, bundled); Blue Gem % is a lookup in a bundled
// compact dataset (playside/top blue coverage). The finish + weapon come from the market name.
// Finishes where the paint SEED (pattern) actually drives value — only show #seed on these, else
// it's noise on skins where every copy looks the same.
const PATTERN_SKIN_RE = /\b(Case Hardened|Heat Treated|Marble Fade|Fade|Crimson Web|Blue Web|Emerald Web|Slaughter|Hydroponic|Phoenix Blacklight|Kumicho Dragon)\b/i;
const isPatternSkin = (name: string): boolean => PATTERN_SKIN_RE.test(name);
const baseWeapon = (name: string): string =>
    name.replace(/^★\s*/, "").replace(/^StatTrak™\s*/, "").replace(/^Souvenir\s*/, "").split("|")[0].trim();
const finishOf = (name: string): string => (name.match(/\|\s*([^(]+?)\s*(?:\(|$)/)?.[1] ?? "").trim();
function fadePercent(name: string, seed?: number): number | null {
    if (seed == null) return null;
    const f = finishOf(name);
    const calc = f === "Fade" ? FadeCalculator : f === "Amber Fade" ? AmberFadeCalculator : f === "Acid Fade" ? AcidFadeCalculator : null;
    if (!calc) return null;
    try { return calc.getFadePercentage(baseWeapon(name), seed).percentage; } catch { return null; } // weapon not in that fade set
}
function blueGemPercent(name: string, seed?: number): number | null {
    if (seed == null) return null;
    return (bluegemData as any)[finishOf(name)]?.[baseWeapon(name)]?.[seed] ?? null;
}
// Memoized per name|seed so a big inventory doesn't recompute fade/blue on every keystroke re-render.
const patMemo = new Map<string, { fade: number | null; blue: number | null }>();
function patternBadges(name: string, seed?: number): { fade: number | null; blue: number | null } {
    const key = `${name}|${seed}`;
    let v = patMemo.get(key);
    if (!v) { v = { fade: fadePercent(name, seed), blue: blueGemPercent(name, seed) }; patMemo.set(key, v); }
    return v;
}
const fadeBadge = (name: string, seed?: number): string => {
    const { fade, blue } = patternBadges(name, seed);
    let h = "";
    if (fade != null) h += `<span class="vsi-modal-fade" title="Fade percentage">${Math.round(fade)}% fade</span>`;
    if (blue != null) h += `<span class="vsi-modal-blue" title="Blue Gem — playside blue coverage">${blue}% blue</span>`;
    return h;
};

let modalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
function closeInventoryModal() {
    closeItemMenu();
    document.querySelector(".vsi-modal-backdrop")?.remove();
    if (modalKeyHandler) { document.removeEventListener("keydown", modalKeyHandler); modalKeyHandler = null; }
}

async function openInventoryModal(steamId: string, displayName: string) {
    closeInventoryModal(); // never stack two
    const cur = settings.store.marketCurrency || 1;

    const backdrop = document.createElement("div");
    backdrop.className = "vsi-modal-backdrop";
    backdrop.addEventListener("click", e => { if (e.target === backdrop) closeInventoryModal(); });
    const modal = document.createElement("div");
    modal.className = "vsi-modal";
    modal.innerHTML = `
        <div class="vsi-modal-head">
            <span class="vsi-modal-title"><b>${escapeHtml(displayName)}</b> — CS2 Inventory</span>
            <span class="vsi-modal-total"></span>
            <button class="vsi-modal-x" title="Close">×</button>
        </div>
        <div class="vsi-modal-tools">
            <input class="vsi-modal-search" type="text" placeholder="Search items…" />
            <button class="vsi-modal-sort">Sort: Value</button>
        </div>
        <div class="vsi-modal-filters"></div>
        <div class="vsi-modal-list"><div class="vsi-modal-empty">Loading…</div></div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector(".vsi-modal-x")!.addEventListener("click", closeInventoryModal);
    modalKeyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") closeInventoryModal(); };
    document.addEventListener("keydown", modalKeyHandler);

    const totalEl = modal.querySelector<HTMLElement>(".vsi-modal-total")!;
    const listEl = modal.querySelector<HTMLElement>(".vsi-modal-list")!;
    const searchEl = modal.querySelector<HTMLInputElement>(".vsi-modal-search")!;
    const sortEl = modal.querySelector<HTMLButtonElement>(".vsi-modal-sort")!;
    const filtersEl = modal.querySelector<HTMLElement>(".vsi-modal-filters")!;
    let items: PricedItem[] = [];
    let total = 0;
    let note = "";
    let loading = true;
    let sortMode: "value" | "name" = "value";
    let currentRows: PricedItem[] = []; // items currently rendered, indexed by row data-i (for right-click)
    let query = "";
    let typeFilter: string | null = null;

    // Type-filter chips: only the categories actually present, in a sensible order, "All" first.
    // Memoized so it only rebuilds when the category set or active filter changes (not per keystroke).
    const TYPE_ORDER = ["Knives", "Gloves", "Rifles", "Snipers", "Pistols", "SMGs", "Heavy", "Agents", "Stickers", "Charms", "Graffiti", "Music Kits", "Cases", "Pins", "Other"];
    let filtersSig = "";
    const renderFilters = () => {
        const present = TYPE_ORDER.filter(c => items.some(i => i.catType === c));
        const sig = present.join("|") + "::" + (typeFilter ?? "");
        if (sig === filtersSig) return;
        filtersSig = sig;
        if (present.length <= 1) { filtersEl.innerHTML = ""; return; }
        filtersEl.innerHTML = ["All", ...present].map(c => {
            const active = (c === "All" && !typeFilter) || c === typeFilter;
            return `<button class="vsi-modal-chip${active ? " active" : ""}" data-cat="${c === "All" ? "" : escapeHtml(c)}">${c}</button>`;
        }).join("");
    };
    filtersEl.addEventListener("click", e => {
        const chip = (e.target as HTMLElement)?.closest<HTMLElement>(".vsi-modal-chip");
        if (!chip) return;
        typeFilter = chip.dataset.cat || null;
        filtersSig = ""; // force chip active-state rebuild
        renderFilters(); render();
    });

    const render = () => {
        renderFilters();
        totalEl.textContent = items.length ? fmt(total, cur) : "";
        if (loading) { listEl.innerHTML = "<div class=\"vsi-modal-empty\">Loading full inventory…</div>"; return; }
        if (!items.length) { listEl.innerHTML = "<div class=\"vsi-modal-empty\">Couldn't load this inventory — it may be private.</div>"; return; }
        const filtered = items.filter(i => (!query || abbrevItem(i.name).toLowerCase().includes(query)) && (!typeFilter || i.catType === typeFilter));
        filtered.sort((a, b) => sortMode === "value"
            ? (b.price * b.qty) - (a.price * a.qty)
            : abbrevItem(a.name).localeCompare(abbrevItem(b.name)));
        if (!filtered.length) { listEl.innerHTML = "<div class=\"vsi-modal-empty\">No items match your search.</div>"; return; }
        currentRows = filtered;
        const rows = filtered.map((i, idx) => {
            const sv = (i.stickerValue ?? 0) * i.qty;
            const badge = i.stickerCount
                ? `<span class="vsi-modal-sticker${sv >= 50 ? " grail" : ""}" title="${i.stickerCount} sticker${i.stickerCount > 1 ? "s" : ""}">+${fmt(sv, cur)}</span>`
                : "";
            // Highlight pills — only the notable/rare stuff pops (StatTrak/Souvenir, fade %, blue gem,
            // low/high-float, sticker value). Routine specs (wear · float · seed) stay quiet.
            const pills = [
                stTag(i.name),
                fadeBadge(i.name, i.seed),
                i.floatFlag ? `<span class="vsi-modal-frank ${i.floatFlag}" title="${i.floatFlag === "low" ? "Ranked low float for this skin (FloatDB)" : "Ranked high float for this skin (FloatDB)"}">${i.floatFlag === "low" ? "🥇 low" : "high"}</span>` : "",
                badge,
            ].filter(Boolean).join("");
            const spec = [
                wearTag(i.name),
                i.float != null ? `<span class="vsi-modal-float" title="float / wear value">${i.float.toFixed(4)}</span>` : "",
                i.seed != null && isPatternSkin(i.name) ? `<span class="vsi-modal-seed" title="paint seed / pattern">#${i.seed}</span>` : "",
            ].filter(Boolean).join("");
            return `
            <a class="vsi-modal-row" href="${itemHref(i, steamId)}" target="_blank" rel="noopener noreferrer" data-i="${idx}" title="${clickActionLabel(i)} · right-click for more"${rarityAccent(i.rarity)}>
                ${i.icon ? `<img class="vsi-modal-thumb" src="${steamThumb(i.icon)}" loading="lazy" />` : "<div class=\"vsi-modal-thumb\"></div>"}
                <span class="vsi-modal-name">${escapeHtml(modalName(i.name))}${i.nametag ? ` <span class="vsi-modal-nametag" title="Custom name tag">“${escapeHtml(i.nametag)}”</span>` : ""}</span>
                ${pills ? `<span class="vsi-modal-pills">${pills}</span>` : ""}
                ${spec ? `<span class="vsi-modal-spec">${spec}</span>` : ""}
                ${i.qty > 1 ? `<span class="vsi-modal-qty">×${i.qty}</span>` : ""}
                <span class="vsi-modal-price">${fmt(i.price * i.qty, cur)}</span>
                <span class="vsi-modal-ext">↗</span>
            </a>`;
        }).join("");
        listEl.innerHTML = (note ? `<div class="vsi-modal-empty">${escapeHtml(note)}</div>` : "") + rows;
    };

    // Right-click a row → the configured rightClickAction. "menu" pops a picker; anything else
    // fires that action straight away.
    listEl.addEventListener("contextmenu", e => {
        const row = (e.target as HTMLElement)?.closest?.(".vsi-modal-row") as HTMLElement | null;
        const i = row ? currentRows[+(row.dataset.i ?? -1)] : null;
        if (!i) return;
        e.preventDefault();
        const acts = rowActions(i, steamId);
        const mode = (settings.store.rightClickAction as string) || "menu";
        if (mode === "menu") { showItemMenu(e.clientX, e.clientY, acts); return; }
        const chosen = acts.find(a => a.kind === mode) ?? acts.find(a => a.kind === "market");
        if (chosen?.url) openProtocol(chosen.url);
        else if (chosen?.copy && copyText(chosen.copy)) try { BD.UI?.showToast?.("Copied inspect link", { type: "success" }); } catch { /* */ }
    });
    // Left-click when the action is "inspect" → the row href is steam://; Discord won't open that
    // from a normal anchor nav, so intercept and route it through openProtocol (http rows fall through).
    listEl.addEventListener("click", e => {
        const row = (e.target as HTMLElement)?.closest?.("a.vsi-modal-row") as HTMLAnchorElement | null;
        const href = row?.getAttribute("href");
        if (href && href.startsWith("steam://")) { e.preventDefault(); openProtocol(href); }
    });
    searchEl.addEventListener("input", () => { query = searchEl.value.trim().toLowerCase(); render(); });
    sortEl.addEventListener("click", () => {
        sortMode = sortMode === "value" ? "name" : "value";
        sortEl.textContent = sortMode === "value" ? "Sort: Value" : "Sort: Name";
        render();
    });
    render();
    searchEl.focus();

    // Data: use the local full list if we have it; otherwise price it now so every item shows
    // with its thumbnail (instead of an icon-less "top items only" summary).
    const local = (await getItemsSnaps(steamId))[0];
    if (!backdrop.isConnected) return;
    if (local?.items?.length) {
        items = local.items; total = local.total; loading = false; render();
        // Cached before floats/nametags/types existed? If it has skins but no per-item float, re-price
        // in the background and re-render with the richer data — self-heals so the next open is instant.
        const hasFloat = local.items.some(i => i.float != null);
        const hasSkin = local.items.some(i => /\((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)/.test(i.name));
        if (!hasFloat && hasSkin) {
            priceSteamId(steamId).then(inv => { if (backdrop.isConnected) { items = inv.allItems; total = inv.total; render(); } }).catch(() => { /* */ });
        }
        return;
    }
    try {
        const inv = await priceSteamId(steamId, undefined, () => {
            // Background Steam fallback landed → re-render with the fuller list.
            getItemsSnaps(steamId).then(s => {
                if (backdrop.isConnected && s[0]?.items?.length) { items = s[0].items; total = s[0].total; render(); }
            }).catch(() => { /* */ });
        });
        if (!backdrop.isConnected) return;
        items = inv.allItems; total = inv.total; loading = false; render();
    } catch {
        if (!backdrop.isConnected) return;
        loading = false;
        // Private / failed → show whatever summary we already have (top items, no thumbnails).
        const snap = (await getSnapshots(steamId))[0] ?? await cacheGetInventory(steamId, cur);
        if (snap?.topItems?.length) {
            items = snap.topItems.map(t => ({ name: t.name, price: t.price, qty: 1 }));
            total = snap.total;
            note = "Top items only — this inventory couldn't be fully loaded.";
        }
        render();
    }
}

async function openInventoryModalForUser(shownUserId: string) {
    const steamId = await getSteamId(shownUserId);
    if (!steamId) return;
    const name = UserStore?.getUser?.(shownUserId)?.username ?? "CS2 Inventory";
    await openInventoryModal(steamId, name);
}

// Re-evaluate injection for one user after toggling their card on/off: drop any existing card and
// re-scan open popouts (tryInject re-adds it only if the user is now enabled).
function applyCardToggle(userId: string) {
    document.querySelectorAll(`[data-vsi-user="${userId}"]`).forEach(n => n.remove());
    scan(document.body);
}

// ─── Right-click user context menu → CS2 Inventory ─────────────────────────────
let unpatchContextMenu: (() => void) | null = null;
function registerContextMenu() {
    if (!BD.ContextMenu?.patch) return;
    unpatchContextMenu = BD.ContextMenu.patch("user-context", (ret: any, props: any) => {
        try {
            const userId = props?.user?.id;
            if (!userId || !ret?.props?.children) return ret;
            const items: any[] = [];
            // In opt-in mode, a per-user toggle to show/hide the card on their profile.
            if (((settings.store.inventoryMode as string) || "enabled") === "enabled") {
                items.push(BD.ContextMenu.buildItem({
                    type: "toggle",
                    id: "vsi-show-card",
                    label: "Show CS2 inventory",
                    checked: isCardEnabled(userId),
                    action: () => { setCardEnabled(userId, !isCardEnabled(userId)); applyCardToggle(userId); },
                }));
            }
            // Always: open the full breakdown for a one-off look, no matter the mode.
            items.push(BD.ContextMenu.buildItem({
                id: "vsi-inventory",
                label: "CS2 Inventory breakdown",
                action: () => { openInventoryModalForUser(userId).catch(e => console.error("[VSI] ctx modal", e)); },
            }));
            const kids = ret.props.children;
            if (Array.isArray(kids)) kids.push(...items);
            else ret.props.children = [kids, ...items];
        } catch (e) { console.error("[VSI] context menu patch", e); }
        return ret;
    });
}
function unregisterContextMenu() {
    try { unpatchContextMenu?.(); } catch { /* */ }
    unpatchContextMenu = null;
}

function scan(root: ParentNode) {
    // Discord's stable class is `user-profile-popout` (kebab-case). Older camelCase kept as fallback.
    const sel = '[class*="user-profile-popout"], [class~="user-profile-popout"], [class*="userPopout"], [class*="userProfile"], [class*="userPanelOuter"], [class*="profilePanel"]';
    if (root instanceof HTMLElement && root.matches(sel)) tryInject(root);
    root.querySelectorAll<HTMLElement>(sel).forEach(tryInject);
}

// Discord's DOM mutates constantly (messages, typing, animations). Instead of running the popout
// selector on every added node, we set a flag on any element addition and do ONE scan during the
// next idle slice — collapsing bursts into a single cheap pass. Profile popouts are still caught
// within a few hundred ms (imperceptible; the card loads async anyway).
let scanScheduled = false;
function scheduleScan() {
    if (scanScheduled || !observer) return;
    scanScheduled = true;
    // Next animation frame (~16ms), not requestIdleCallback — still collapses a burst of mutations
    // into a single scan (the CPU win), but injects the card near-instantly so it never pops in.
    requestAnimationFrame(() => { scanScheduled = false; if (observer) scan(document.body); });
}

function startObserver() {
    scanScheduled = false;
    observer = new MutationObserver(muts => {
        for (const m of muts) {
            for (const n of m.addedNodes) {
                if (n instanceof HTMLElement) { scheduleScan(); return; }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
}

// ─── Settings panel (BetterDiscord) ─────────────────────────────────────────
function prettyName(id: string): string {
    return id.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();
}

// "Made by reap" credit block pinned above the settings.
const DONATE_URL = "https://steamcommunity.com/tradeoffer/new/?partner=1149562692&token=smsukaox";
const GITHUB_URL = "https://github.com/VisaHolder/cs2-inventory-betterdiscord";
const DISCORD_HANDLE = "reap.";
function buildAboutSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "vsi-about";
    el.innerHTML = `
        <div class="vsi-about-head">
            <span class="vsi-about-logo">💼</span>
            <div class="vsi-about-titles">
                <div class="vsi-about-title">CS2 Inventory Value</div>
                <div class="vsi-about-by">made by <b>reap</b></div>
            </div>
        </div>
        <div class="vsi-about-links">
            <a class="vsi-about-link" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">🐙 GitHub</a>
            <span class="vsi-about-link vsi-about-copy" title="Click to copy">💬 ${escapeHtml(DISCORD_HANDLE)}</span>
            <a class="vsi-about-link vsi-about-donate" href="${DONATE_URL}" target="_blank" rel="noopener noreferrer" title="Send a skin — thank you 💛">💛 Donate a skin</a>
        </div>
    `;
    el.querySelector(".vsi-about-copy")?.addEventListener("click", () => {
        try { navigator.clipboard.writeText(DISCORD_HANDLE); BD.UI?.showToast?.("Discord copied", { type: "success" }); } catch { /* */ }
    });
    return el;
}

function buildSettingsPanel(): any {
    const items = Object.entries(SETTINGS_SCHEMA).map(([id, def]: [string, any]) => {
        const base: any = { id, name: prettyName(id), note: def.description, value: (settings.store as any)[id] };
        if (def.type === OptionType.BOOLEAN) return { ...base, type: "switch" };
        if (def.type === OptionType.NUMBER) return { ...base, type: "number" };
        if (def.type === OptionType.SELECT) {
            return { ...base, type: "dropdown", options: (def.options || []).map((o: any) => ({ label: o.label, value: o.value })) };
        }
        return { ...base, type: "text", placeholder: def.placeholder || "" };
    });
    return BD.UI.buildSettingsPanel({
        settings: items,
        onChange: (_cat: any, id: string, value: any) => {
            (settings.store as any)[id] = value;
            // Share your trade URL to the cache the moment you set it, so other addon users
            // see a Trade button on your profile right away.
            if (id === "tradeUrl" || id === "useSharedCache" || id === "shareTradeUrl") cachePushTradeUrl().catch(() => { /* best-effort */ });
            // Paste a webapi_token → re-price your own inventory so trade-held items (gloves/knives) appear.
            if (id === "steamWebApiToken" && typeof value === "string" && value.trim()) {
                const sid = tokenSteamId(value.trim());
                if (sid) priceSteamId(sid)
                    .then(() => { try { BD.UI?.showToast?.("Loaded your full inventory (held items included).", { type: "success" }); } catch { /* */ } })
                    .catch(() => { try { BD.UI?.showToast?.("Couldn't load — token may be invalid or expired.", { type: "error" }); } catch { /* */ } });
            }
            if (id === "resetHistory" && value === true) {
                const n = clearAllHistory();
                (settings.store as any).resetHistory = false;
                try { BD.UI?.showToast?.(`Cleared price history for ${n} profile${n === 1 ? "" : "s"}.`, { type: "success" }); } catch { /* */ }
            }
        },
    });
}

// ─── /inventory slash command (BetterDiscord's BdApi.Commands) ──────────────────
type PricedLike = { total: number; priced: number; marketableCount?: number; uniqueNames: number; topItems?: { name: string; price: number }[]; skippedNonMarketable?: number; stickerTotal?: number };

// " · incl. C$X stickers" when there's sticker value to call out, else "".
const stickerSuffix = (stickerTotal: number | undefined, cur: number): string =>
    stickerTotal && stickerTotal > 0 ? ` · incl. ${fmt(stickerTotal, cur)} stickers` : "";

function invMarkdown(displayName: string, r: PricedLike, cur: number, steamId?: string, tradeUrl?: string, changed?: string): string {
    const top = r.topItems ?? [];
    // Currency symbol pinned to the left edge, number right-padded so the decimal points
    // line up (padding the whole "C$40.59" instead made the C$ column ragged).
    const sym = currencySymbol(cur);
    const nums = top.map(i => i.price.toFixed(2));
    const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
    const body = top.map((i, k) => `${sym}${nums[k].padStart(w)}  ${abbrevItem(i.name)}`).join("\n");
    const untr = (r.skippedNonMarketable ?? 0) > 0 ? ` · ${r.skippedNonMarketable} untradeable` : "";
    // Public message: Discord doesn't render masked links for user messages, so links are
    // labeled bare URLs wrapped in <> (clickable, no big embed card), one per subtext line.
    const links = [
        steamId ? `Steam · <https://steamcommunity.com/profiles/${steamId}>` : "",
        tradeUrl ? `Trade · <${tradeUrl}>` : "",
    ].filter(Boolean).join("\n-# ");
    return `## ${displayName} — ${fmt(r.total, cur)}\n`
        + `-# ${r.priced}/${r.marketableCount ?? r.priced} priced · ${r.uniqueNames} unique${untr}${stickerSuffix(r.stickerTotal, cur)}`
        + (changed ? `\n-# ${changed}` : "")
        + (body ? `\n\`\`\`\n${body}\n\`\`\`` : "")
        + (links ? `\n-# ${links}` : "");
}

// Embed for the ephemeral ("only you") reply — embeds DO render masked links, so the
// Steam / Trade links become clean clickable words instead of bare URLs.
function invEmbed(displayName: string, r: PricedLike, cur: number, steamId?: string, tradeUrl?: string, changed?: string): any {
    const sym = currencySymbol(cur);
    const top = r.topItems ?? [];
    const nums = top.map(i => i.price.toFixed(2));
    const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
    const body = top.map((i, k) => `${sym}${nums[k].padStart(w)}  ${abbrevItem(i.name)}`).join("\n");
    const untr = (r.skippedNonMarketable ?? 0) > 0 ? ` · ${r.skippedNonMarketable} untradeable` : "";
    const linkParts: string[] = [];
    if (steamId) linkParts.push(`[Steam Profile](https://steamcommunity.com/profiles/${steamId})`);
    if (tradeUrl) linkParts.push(`[Send Trade Offer](${tradeUrl})`);
    let description = `${r.priced}/${r.marketableCount ?? r.priced} priced · ${r.uniqueNames} unique${untr}${stickerSuffix(r.stickerTotal, cur)}`;
    if (changed) description += `\n*${changed}*`;
    if (body) description += `\n\`\`\`\n${body}\n\`\`\``;
    if (linkParts.length) description += `\n${linkParts.join("  ·  ")}`;
    return { color: 0x5865F2, title: `${displayName} — ${fmt(r.total, cur)}`, description };
}

// Resolves + prices an inventory and returns the raw pieces, so execute can render it either
// as a public markdown message or as an ephemeral embed (clickable links).
type InvData = { error: string } | { displayName: string; r: PricedLike; cur: number; steamId: string; tradeUrl?: string; changed?: string };

async function buildInventoryData(args: any[]): Promise<InvData> {
    const userId = args.find((a: any) => a.name === "user")?.value as string | undefined;
    const steamRef = String(args.find((a: any) => a.name === "steam")?.value ?? "").trim();
    const d = await priceRef(userId, steamRef);
    if ("error" in d) return d;
    return { ...d, changed: (await buildDiffLine(d.steamId)) ?? undefined };
}

// Prices one side (a Discord user id OR a Steam ref string). Shared by /inventory and /compare.
async function priceRef(userId: string | undefined, steamRef: string): Promise<InvData> {
    let steamId: string | null = null;
    let displayName = "CS2 Inventory";
    if (userId) {
        displayName = UserStore?.getUser?.(userId)?.username ?? "User";
        steamId = await getSteamId(userId).catch(() => null);
        if (!steamId) return { error: `**${displayName}** has no visible Steam account linked on Discord.` };
    } else if (steamRef) {
        const resolved = await resolveSteamRef(steamRef).catch(() => null);
        if (!resolved) return { error: `Couldn't resolve **${steamRef}** to a Steam profile. Try a full URL, a vanity, or a raw SteamID64.` };
        steamId = resolved.steamId;
        displayName = resolved.persona ?? `SteamID ${resolved.steamId}`;
    } else {
        return { error: "Give me a **user** or a **steam** ref (URL / vanity / SteamID64)." };
    }

    const cur = settings.store.marketCurrency || 1;
    // Owner-published trade URL from the shared cache (undefined if they never set one).
    const tradeUrl = (await cacheGetTradeUrl(steamId)) ?? undefined;
    // Cache-first for speed; else price via CSFloat (the slow live fallback is skipped in commands).
    const cached = await cacheGetInventory(steamId, cur);
    if (cached) return { displayName, r: cached, cur, steamId, tradeUrl };

    const validSources = new Set(["csfloat", "skinport", "live_steam"]);
    const stored = settings.store.priceSource as string;
    const source = validSources.has(stored) ? stored : "csfloat";
    const inv = await loadInventory(steamId, { source, useLiveFallback: false });
    if (inv.isPrivate) return { error: `**${displayName}**'s Steam inventory is private.` };
    cachePushInventory(steamId, { total: inv.total, priced: inv.priced, itemCount: inv.count, marketableCount: inv.marketableCount, uniqueNames: inv.uniqueNames, ts: Date.now(), source, currency: cur, topItems: inv.topItems }, displayName);
    return { displayName, r: inv, cur, steamId, tradeUrl };
}

// Deliver a command result: "Post Publicly" ON → send a real message everyone sees (markdown,
// nonce required or Discord silently drops it); OFF (or no channel) → ephemeral embed. Returning
// undefined tells BetterDiscord we've already sent it.
function deliver(ctx: any, markdown: string, embed: any): any {
    if (settings.store.postPublicly && MessageActions?.sendMessage) {
        const channelId = ctx?.channel?.id ?? SelectedChannelStore?.getChannelId?.();
        if (channelId) {
            MessageActions.sendMessage(channelId, { content: markdown, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, { nonce: String(Date.now()) });
            return undefined;
        }
    }
    return { embeds: [embed] };
}

// ─── /leaderboard ───────────────────────────────────────────────────────────
type LbRow = { steamId: string; total: number; name?: string };

async function buildLeaderboard(limit: number, guildId?: string): Promise<{ error: string } | { rows: LbRow[]; cur: number }> {
    const cur = settings.store.marketCurrency || 1;
    const rows = await cacheGetLeaderboard(limit, cur, guildId);
    if (!rows.length) return {
        error: guildId
            ? "No inventories tracked in this server yet — run `/inventory` on people here to seed it."
            : "No inventories tracked yet — run `/inventory` on someone to seed the leaderboard.",
    };
    // Fill any missing display names (old entries) from their Steam persona, in parallel.
    await Promise.all(rows.map(async r => {
        if (!r.name) {
            const resolved = await resolveSteamRef(r.steamId).catch(() => null);
            r.name = resolved?.persona || `SteamID …${r.steamId.slice(-5)}`;
        }
    }));
    return { rows, cur };
}

function lbBody(rows: LbRow[], cur: number): string {
    const totals = rows.map(r => fmt(r.total, cur));
    const tw = totals.reduce((a, s) => Math.max(a, s.length), 0);
    const rw = String(rows.length).length;
    return rows.map((r, i) => `${String(i + 1).padStart(rw)}. ${totals[i].padStart(tw)}  ${r.name}`).join("\n");
}
function leaderboardMarkdown(rows: LbRow[], cur: number, scoped = false): string {
    const sub = scoped ? "this server · by value" : "by value";
    return `## CS2 Inventory Leaderboard${scoped ? " — This Server" : ""}\n-# ${sub}\n\`\`\`\n${lbBody(rows, cur)}\n\`\`\``;
}
function leaderboardEmbed(rows: LbRow[], cur: number, scoped = false): any {
    const sub = scoped ? "this server · by value" : "by value";
    return { color: 0x5865F2, title: `CS2 Inventory Leaderboard${scoped ? " — This Server" : ""}`, description: `\`\`\`\n${lbBody(rows, cur)}\n\`\`\``, footer: { text: sub } };
}

// ─── /compare ───────────────────────────────────────────────────────────────
type Side = { displayName: string; total: number };
async function buildCompare(args: any[]): Promise<{ error: string } | { a: Side; b: Side; cur: number }> {
    const aUser = args.find((x: any) => x.name === "a")?.value as string | undefined;
    const aSteam = String(args.find((x: any) => x.name === "a_steam")?.value ?? "").trim();
    const bUser = args.find((x: any) => x.name === "b")?.value as string | undefined;
    const bSteam = String(args.find((x: any) => x.name === "b_steam")?.value ?? "").trim();
    if ((!aUser && !aSteam) || (!bUser && !bSteam)) return { error: "Give me **two** sides — `a` and `b` (each a Discord user or a Steam ref)." };
    const [da, db] = await Promise.all([priceRef(aUser, aSteam), priceRef(bUser, bSteam)]);
    if ("error" in da) return { error: `First: ${da.error}` };
    if ("error" in db) return { error: `Second: ${db.error}` };
    return { a: { displayName: da.displayName, total: da.r.total }, b: { displayName: db.displayName, total: db.r.total }, cur: da.cur };
}

function compareVerdict(a: Side, b: Side, cur: number): string {
    const diff = Math.abs(a.total - b.total);
    if (diff < 0.005) return "Dead tie.";
    const winner = a.total > b.total ? a : b;
    return `${winner.displayName} wins by ${fmt(diff, cur)}`;
}
function compareBody(a: Side, b: Side, cur: number): string {
    const nw = Math.max(a.displayName.length, b.displayName.length);
    const line = (s: Side) => `${s.displayName.padEnd(nw)}  ${fmt(s.total, cur)}`;
    return `${line(a)}\n${line(b)}`;
}
function compareMarkdown(a: Side, b: Side, cur: number): string {
    return `## ${a.displayName} vs ${b.displayName}\n\`\`\`\n${compareBody(a, b, cur)}\n\`\`\`\n-# ${compareVerdict(a, b, cur)}`;
}
function compareEmbed(a: Side, b: Side, cur: number): any {
    return { color: 0x5865F2, title: `${a.displayName} vs ${b.displayName}`, description: `\`\`\`\n${compareBody(a, b, cur)}\n\`\`\``, footer: { text: compareVerdict(a, b, cur) } };
}

// ─── /price ───────────────────────────────────────────────────────────────────
type PriceHit = { name: string; price: number };
async function buildPriceLookup(query: string): Promise<{ error: string } | { results: PriceHit[]; cur: number; exact: boolean }> {
    const q = query.trim();
    if (!q) return { error: "Give me an item name, e.g. `/price AK-47 | Redline (Field-Tested)`." };
    const cur = settings.store.marketCurrency || 1;
    // Live-Steam has no bulk feed to search — fall back to CSFloat's list for the lookup.
    const stored = settings.store.priceSource as string;
    const source = stored === "skinport" ? "skinport" : "csfloat";
    const bulk = await getBulkPrices(source);
    if (!bulk.size) return { error: "Price feed unavailable right now — try again in a moment." };
    // Exact match (case-insensitive) → single authoritative result.
    let exactName: string | null = bulk.has(q) ? q : null;
    if (!exactName) { const lc = q.toLowerCase(); for (const k of bulk.keys()) if (k.toLowerCase() === lc) { exactName = k; break; } }
    if (exactName) return { results: [{ name: exactName, price: bulk.get(exactName)! }], cur, exact: true };
    // Otherwise a fuzzy contains search, richest first.
    const lc = q.toLowerCase();
    const matches: PriceHit[] = [];
    for (const [name, price] of bulk) if (name.toLowerCase().includes(lc)) matches.push({ name, price });
    if (!matches.length) return { error: `No market item matches **${q}**. Try the full name incl. wear, e.g. \`AK-47 | Redline (Field-Tested)\`.` };
    matches.sort((a, b) => b.price - a.price);
    return { results: matches.slice(0, 6), cur, exact: false };
}

const priceUrl = (name: string) => steamMarketUrl({ name, price: 0, qty: 1 });
function priceMarkdown(results: PriceHit[], cur: number, exact: boolean): string {
    if (exact || results.length === 1) {
        const r = results[0];
        return `## ${abbrevItem(r.name)} — ${fmt(r.price, cur)}\n-# Steam Market · <${priceUrl(r.name)}>`;
    }
    const nums = results.map(r => fmt(r.price, cur));
    const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
    const body = results.map((r, k) => `${nums[k].padStart(w)}  ${abbrevItem(r.name)}`).join("\n");
    return `## Price matches\n-# closest matches, priciest first\n\`\`\`\n${body}\n\`\`\``;
}
function priceEmbed(results: PriceHit[], cur: number, exact: boolean): any {
    if (exact || results.length === 1) {
        const r = results[0];
        return { color: 0x5865F2, title: `${abbrevItem(r.name)} — ${fmt(r.price, cur)}`, description: `[Steam Community Market](${priceUrl(r.name)})` };
    }
    const nums = results.map(r => fmt(r.price, cur));
    const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
    const body = results.map((r, k) => `${nums[k].padStart(w)}  ${abbrevItem(r.name)}`).join("\n");
    return { color: 0x5865F2, title: "Price matches", description: `\`\`\`\n${body}\n\`\`\``, footer: { text: "closest matches, priciest first" } };
}

function registerCommands(): void {
    try {
        BD.Commands?.register?.(PLUGIN_NAME, {
            id: "inventory",
            name: "inventory",
            description: "Show a CS2 inventory value in chat — pick a user or paste a Steam ref",
            options: [
                { name: "user", description: "Discord user (uses their linked Steam)", type: 6, required: false },
                { name: "steam", description: "OR a Steam profile URL / vanity / SteamID64", type: 3, required: false },
            ],
            execute: async (cmdArgs: any[], ctx: any) => {
                try {
                    const d = await buildInventoryData(cmdArgs ?? []);
                    if ("error" in d) return { content: d.error };
                    return deliver(ctx, invMarkdown(d.displayName, d.r, d.cur, d.steamId, d.tradeUrl, d.changed), invEmbed(d.displayName, d.r, d.cur, d.steamId, d.tradeUrl, d.changed));
                } catch (e) { console.error("[VSI] /inventory", e); return { content: "Error pricing that inventory — try again in a moment." }; }
            },
        });

        BD.Commands?.register?.(PLUGIN_NAME, {
            id: "leaderboard",
            name: "leaderboard",
            description: "Richest CS2 inventories the addon has priced",
            options: [
                { name: "count", description: "How many to show (default 10, max 25)", type: 4, required: false },
                { name: "here", description: "Only inventories tracked in this server", type: 5, required: false },
            ],
            execute: async (cmdArgs: any[], ctx: any) => {
                try {
                    const raw = Number(cmdArgs?.find((a: any) => a.name === "count")?.value);
                    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 10, 1), 25);
                    const here = !!cmdArgs?.find((a: any) => a.name === "here")?.value;
                    const guildId = here ? (SelectedGuildStore?.getGuildId?.() || "") : "";
                    if (here && !guildId) return { content: "Run `/leaderboard here` inside a server (not a DM)." };
                    const d = await buildLeaderboard(limit, guildId || undefined);
                    if ("error" in d) return { content: d.error };
                    return deliver(ctx, leaderboardMarkdown(d.rows, d.cur, !!guildId), leaderboardEmbed(d.rows, d.cur, !!guildId));
                } catch (e) { console.error("[VSI] /leaderboard", e); return { content: "Couldn't load the leaderboard — try again in a moment." }; }
            },
        });

        BD.Commands?.register?.(PLUGIN_NAME, {
            id: "price",
            name: "price",
            description: "Look up the market price of a CS2 item",
            options: [
                { name: "item", description: "Item name incl. wear, e.g. AK-47 | Redline (Field-Tested)", type: 3, required: true },
            ],
            execute: async (cmdArgs: any[], ctx: any) => {
                try {
                    const q = String(cmdArgs?.find((a: any) => a.name === "item")?.value ?? "");
                    const d = await buildPriceLookup(q);
                    if ("error" in d) return { content: d.error };
                    return deliver(ctx, priceMarkdown(d.results, d.cur, d.exact), priceEmbed(d.results, d.cur, d.exact));
                } catch (e) { console.error("[VSI] /price", e); return { content: "Couldn't look up that price — try again in a moment." }; }
            },
        });

        BD.Commands?.register?.(PLUGIN_NAME, {
            id: "compare",
            name: "compare",
            description: "Compare two CS2 inventories side by side",
            options: [
                { name: "a", description: "First Discord user", type: 6, required: false },
                { name: "b", description: "Second Discord user", type: 6, required: false },
                { name: "a_steam", description: "OR first Steam ref (URL / vanity / SteamID64)", type: 3, required: false },
                { name: "b_steam", description: "OR second Steam ref", type: 3, required: false },
            ],
            execute: async (cmdArgs: any[], ctx: any) => {
                try {
                    const d = await buildCompare(cmdArgs ?? []);
                    if ("error" in d) return { content: d.error };
                    return deliver(ctx, compareMarkdown(d.a, d.b, d.cur), compareEmbed(d.a, d.b, d.cur));
                } catch (e) { console.error("[VSI] /compare", e); return { content: "Couldn't compare those — try again in a moment." }; }
            },
        });
    } catch (e) { console.warn("[VSI] command registration failed (BdApi.Commands unavailable?)", e); }
}

function unregisterCommands(): void {
    try { BD.Commands?.unregisterAll?.(PLUGIN_NAME); } catch { /* */ }
}

// ─── BetterDiscord plugin entry ─────────────────────────────────────────────
// One-time: the plugin was renamed SteamInventoryValue → CS2Inventory. Carry all stored data
// (settings incl. the Steam token & trade URL, price snapshots, enabled users, flags) over from the
// old config file so nobody loses anything on the rename. Runs once, guarded by a flag.
function migrateFromOldName() {
    const OLD = "SteamInventoryValue";
    if (BD.Data.load(PLUGIN_NAME, "cs2.migratedFromSIV")) return;
    try {
        const folder = (BD as any).Plugins?.folder;
        const oldCfg = folder ? `${folder}/${OLD}.config.json` : null;
        const fs = require("fs");
        if (oldCfg && fs.existsSync(oldCfg) && !BD.Data.load(PLUGIN_NAME, "settings")) {
            const data = JSON.parse(fs.readFileSync(oldCfg, "utf8"));
            for (const [k, v] of Object.entries(data)) BD.Data.save(PLUGIN_NAME, k, v);
        }
    } catch (e) { console.error("[VSI] migrate from old name", e); }
    try { BD.Data.save(PLUGIN_NAME, "cs2.migratedFromSIV", true); } catch { /* */ }
}

module.exports = class CS2Inventory {
    start() {
        try { migrateFromOldName(); } catch (e) { console.error("[VSI] migrate", e); }
        // One-time: wipe pre-stable-pricing history (fallback/sticker/pass-inclusive snapshots that
        // polluted deltas & sparklines). Runs once per install of this build.
        try {
            if (!BD.Data.load(PLUGIN_NAME, "vsi.histResetV1")) {
                clearAllHistory();
                BD.Data.save(PLUGIN_NAME, "vsi.histResetV1", true);
            }
        } catch (e) { console.error("[VSI] one-time history reset", e); }
        try { loadEnabledUsers(); } catch (e) { console.error("[VSI] loadEnabledUsers", e); }
        try { ensureStyle(); } catch (e) { console.error("[VSI] ensureStyle", e); }
        try { startObserver(); } catch (e) { console.error("[VSI] startObserver", e); }
        try { registerCommands(); } catch (e) { console.error("[VSI] registerCommands", e); }
        try { registerContextMenu(); } catch (e) { console.error("[VSI] registerContextMenu", e); }
        try { startBackgroundRefresh(); } catch (e) { console.error("[VSI] startBackgroundRefresh", e); }
        try { maybePromptToken(); } catch (e) { console.error("[VSI] maybePromptToken", e); }
        try { setTimeout(() => checkForUpdate().catch(() => { /* */ }), 8000); } catch (e) { console.error("[VSI] checkForUpdate", e); }
        // Re-publish your trade URL each launch so it stays live in the shared cache.
        try { cachePushTradeUrl().catch(() => { /* best-effort */ }); } catch (e) { console.error("[VSI] cachePushTradeUrl", e); }
    }

    stop() {
        observer?.disconnect();
        observer = null;
        stopBackgroundRefresh();
        styleEl?.remove();
        styleEl = null;
        unregisterCommands();
        unregisterContextMenu();
        closeInventoryModal();
        document.querySelectorAll('[data-vsi="1"]').forEach(n => n.remove());
    }

    getSettingsPanel() {
        const wrap = document.createElement("div");
        try { wrap.appendChild(buildAboutSection()); } catch (e) { console.error("[VSI] about", e); }
        try {
            const panel = buildSettingsPanel();
            if (panel instanceof Node) wrap.appendChild(panel);
            else if (panel) { const mount = document.createElement("div"); wrap.appendChild(mount); BD.ReactDOM?.render(panel, mount); }
        } catch (e) { console.error("[VSI] settings panel", e); }
        return wrap;
    }
};
