/**
 * @name SteamInventoryValue
 * @author VisaHolder
 * @description CS2 inventory value on Discord profile popouts — Doppler/Gamma phase pricing (CSFloat), FX-converted prices, and Trade Offer / Steam buttons.
 * @version 1.2.0
 * @source https://github.com/VisaHolder/steam-inventory-value
 * @website https://github.com/VisaHolder/steam-inventory-value
 */


// src/plugin.tsx
var BD = window.BdApi;
var PLUGIN_NAME = "SteamInventoryValue";
var { Webpack } = BD;
var UserStore;
var UserProfileStore;
var SelectedGuildStore;
var SelectedChannelStore;
var RestAPI;
var MessageActions;
try {
  UserStore = Webpack.getStore("UserStore");
} catch {
}
try {
  UserProfileStore = Webpack.getStore("UserProfileStore");
} catch {
}
try {
  SelectedGuildStore = Webpack.getStore("SelectedGuildStore");
} catch {
}
try {
  SelectedChannelStore = Webpack.getStore("SelectedChannelStore");
} catch {
}
try {
  RestAPI = Webpack.getByKeys && Webpack.getByKeys("getAPIBaseURL", "get", "post") || Webpack.getModule((m) => m?.getAPIBaseURL && typeof m?.get === "function" && typeof m?.post === "function");
} catch {
}
try {
  MessageActions = Webpack.getByKeys && Webpack.getByKeys("sendMessage", "editMessage") || Webpack.getModule((m) => typeof m?.sendMessage === "function" && typeof m?.editMessage === "function");
} catch {
}
async function fetchJson(url, opts) {
  const bodyStr = opts?.body != null ? JSON.stringify(opts.body) : void 0;
  const headers = { ...opts?.headers ?? {} };
  if (bodyStr) headers["Content-Type"] = "application/json";
  const res = await BD.Net.fetch(url, { method: opts?.method || "GET", headers, body: bodyStr });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}
async function fetchText(url) {
  const res = await BD.Net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
var OptionType = { STRING: "STRING", NUMBER: "NUMBER", BOOLEAN: "BOOLEAN", SELECT: "SELECT" };
var loadSettings = () => BD.Data.load(PLUGIN_NAME, "settings") || {};
var settings = {
  store: new Proxy({}, {
    get: (_t, key) => {
      const all = loadSettings();
      if (key in all) return all[key];
      return SETTINGS_SCHEMA[key]?.default;
    },
    set: (_t, key, val) => {
      const all = loadSettings();
      all[key] = val;
      BD.Data.save(PLUGIN_NAME, "settings", all);
      return true;
    }
  })
};
var DataStore = {
  get: async (k) => BD.Data.load(PLUGIN_NAME, k),
  set: async (k, v) => {
    BD.Data.save(PLUGIN_NAME, k, v);
  }
};
async function resolveSteamRef(input) {
  let raw = input.trim().replace(/^@+/, "").replace(/\/+$/, "");
  raw = raw.replace(/^<|>$/g, "");
  let steamId = null;
  if (/^7656\d{13}$/.test(raw)) steamId = raw;
  if (!steamId) {
    const m = raw.match(/[?&]partner=(\d+)/);
    if (m) steamId = (76561197960265728n + BigInt(m[1])).toString();
  }
  if (!steamId) {
    const m = raw.match(/\/profiles\/(7656\d{13})/);
    if (m) steamId = m[1];
  }
  if (!steamId) {
    let vanity = null;
    const m = raw.match(/steamcommunity\.com\/id\/([^/?\s]+)/i);
    if (m) vanity = m[1];
    else if (!/[\s/]/.test(raw) && !/^\d+$/.test(raw)) vanity = raw;
    if (vanity) {
      try {
        const xml = await fetchText(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`);
        const m2 = xml.match(/<steamID64>(\d+)<\/steamID64>/);
        if (m2) steamId = m2[1];
      } catch (e) {
        console.warn("[VSI] vanity resolve failed", e);
      }
    }
  }
  if (!steamId) return null;
  try {
    const xml = await fetchText(`https://steamcommunity.com/profiles/${steamId}/?xml=1`);
    const persona = xml.match(/<steamID>(?:<!\[CDATA\[)?([^\]<]+?)(?:\]\]>)?<\/steamID>/)?.[1];
    const avatar = xml.match(/<avatarFull>(?:<!\[CDATA\[)?([^\]<]+?)(?:\]\]>)?<\/avatarFull>/)?.[1];
    return { steamId, persona: persona?.trim(), avatar: avatar?.trim() };
  } catch {
    return { steamId };
  }
}
var SETTINGS_SCHEMA = {
  tradeUrl: {
    type: OptionType.STRING,
    description: "Your Steam trade offer URL. Grab it from steamcommunity.com/my/tradeoffers/privacy \u2014 this is what the Trade button opens.",
    default: "",
    placeholder: "https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
  },
  shareTradeUrl: {
    type: OptionType.BOOLEAN,
    description: "Share your trade URL with other addon users, so they get a Trade button on your profile even without it in your Discord bio. Turn off to keep it private \u2014 it stays saved here, but it's pulled from the shared cache and no one else sees it.",
    default: true
  },
  buttonTheme: {
    type: OptionType.SELECT,
    description: "Color scheme for the Trade and Steam buttons.",
    options: [
      { label: "Blurple \u2014 Discord's brand purple", value: "blurple", default: true },
      { label: "Green \u2014 success-style accent", value: "green" },
      { label: "Steam Blue \u2014 dark navy \u2192 sky-blue gradient", value: "steam" },
      { label: "Dark \u2014 matte black minimal", value: "dark" },
      { label: "Auto \u2014 follows your Discord accent", value: "auto" }
    ]
  },
  showOnOwnProfile: {
    type: OptionType.BOOLEAN,
    description: "Show the Trade + Steam button row on your own profile popout.",
    default: true
  },
  showInventoryOnProfile: {
    type: OptionType.BOOLEAN,
    description: "Show the CS2 Inventory card (value, delta, top 5 items) on profile popouts \u2014 yours and friends'.",
    default: true
  },
  // ── Prices ──────────────────────────────────────────────────────────────
  priceSource: {
    type: OptionType.SELECT,
    description: "Which marketplace's prices to use for /inventory.",
    options: [
      { label: "CSFloat \u2014 bulk (~300ms), refreshed hourly", value: "csfloat", default: true },
      { label: "Skinport \u2014 bulk (USD/GBP/EUR only)", value: "skinport" },
      { label: "Live Steam Market \u2014 always fresh, ~1min per inventory", value: "live_steam" }
    ]
  },
  marketCurrency: {
    type: OptionType.SELECT,
    description: "Currency for prices. CSFloat is USD-only under the hood \u2014 CSFloat mode ignores this. Steam Market and Skinport respect it.",
    options: [
      { label: "USD ($)", value: 1, default: true },
      { label: "CAD (C$)", value: 22 },
      { label: "GBP (\xA3)", value: 2 },
      { label: "EUR (\u20AC)", value: 3 },
      { label: "AUD (A$)", value: 23 },
      { label: "CHF", value: 5 },
      { label: "PLN (z\u0142)", value: 7 },
      { label: "BRL (R$)", value: 8 },
      { label: "SGD (S$)", value: 24 },
      { label: "JPY (\xA5)", value: 9 },
      { label: "RUB (\u20BD)", value: 6 }
    ]
  },
  skinportPriceKind: {
    type: OptionType.SELECT,
    description: "Only applies when Price Source = Skinport. Which price to use.",
    options: [
      { label: "Suggested \u2014 Skinport's mid-market estimate", value: "suggested_price", default: true },
      { label: "Min \u2014 cheapest current listing", value: "min_price" },
      { label: "Median \u2014 middle of all listings", value: "median_price" },
      { label: "Mean \u2014 average of all listings", value: "mean_price" }
    ]
  },
  useLiveSteamFallback: {
    type: OptionType.BOOLEAN,
    description: "When on: after the bulk lookup, hit live Steam Market for anything the bulk feed missed (stickered/nametagged skins). Complete numbers but adds ~2s per missing item.",
    default: false
  },
  csfloatApiKey: {
    type: OptionType.STRING,
    description: "Optional CSFloat API key (csfloat.com \u2192 Profile \u2192 Developer). When set, Doppler & Gamma Doppler knives are priced by their actual phase (Ruby/Sapphire/Black Pearl/Phase 1-4) instead of the generic blended price. Leave blank for generic prices.",
    default: "",
    placeholder: "CSFloat API key"
  },
  includeStickerValue: {
    type: OptionType.BOOLEAN,
    description: "Add applied-sticker value on top of each skin. Off by default \u2014 applied stickers rarely resell for much unless they're very rare, so counting full sticker value overstates what an inventory is actually worth. Turn on only if you want the theoretical sticker-book number.",
    default: false
  },
  useSharedCache: {
    type: OptionType.BOOLEAN,
    description: "Use the shared inventory-value cache. When on, once anyone has priced a profile it loads instantly for everyone else (and phase-accurate prices propagate to users without a CSFloat key). Only the public SteamID + inventory value is shared \u2014 no Discord identity. Turn off to price everything locally.",
    default: true
  },
  // ── Profile card behavior ───────────────────────────────────────────────
  showPriceChange: {
    type: OptionType.BOOLEAN,
    description: "Show a green/red delta chip when the total moved since your last /inventory run.",
    default: true
  },
  showItemCount: {
    type: OptionType.BOOLEAN,
    description: 'Add "X items" to the card meta line.',
    default: false
  },
  deltaMinAgeMinutes: {
    type: OptionType.NUMBER,
    description: 'Ignore snapshots newer than this when computing the delta. Prevents noisy "since 2m ago" deltas from back-to-back runs.',
    default: 60
  },
  snapshotStalenessHours: {
    type: OptionType.NUMBER,
    description: "Mark the card as STALE if the last /inventory is older than this many hours. Set to 0 to never mark stale.",
    default: 24
  },
  postPublicly: {
    type: OptionType.BOOLEAN,
    description: "When on: /inventory sends a real message to the channel (markdown, visible to everyone). When off: rich embed only you see.",
    default: false
  },
  // ── Advanced ────────────────────────────────────────────────────────────
  priceCacheMinutes: {
    type: OptionType.NUMBER,
    description: "How long to keep the bulk price feed in memory before refetching. Skinport/CSFloat only refresh hourly on their end so 60 is fine.",
    default: 60
  },
  requestDelayMs: {
    type: OptionType.NUMBER,
    description: "Live Steam Market only: delay between per-item requests, in milliseconds. 1600 keeps you under Steam's ~20/min rate limit. Bump if you 429.",
    default: 1600
  }
};
function getAccounts(profile) {
  return profile?.connectedAccounts || profile?.connected_accounts || profile?.user?.connectedAccounts || [];
}
async function getSteamId(userId) {
  let profile = UserProfileStore.getUserProfile(userId);
  if (!getAccounts(profile).length) {
    const me = UserStore.getCurrentUser()?.id;
    const guildId = SelectedGuildStore?.getGuildId?.() || "";
    const attempts = [];
    if (userId === me) attempts.push("/users/@me/profile");
    if (guildId) attempts.push(`/users/${userId}/profile?guild_id=${guildId}&with_mutual_guilds=false`);
    attempts.push(`/users/${userId}/profile?with_mutual_guilds=false`);
    attempts.push(`/users/${userId}/profile`);
    for (const url of attempts) {
      try {
        const res = await RestAPI.get({ url });
        const body = res?.body;
        if (body && getAccounts(body).length) {
          profile = body;
          break;
        }
        if (body) profile = body;
      } catch (e) {
        console.warn("[VSI] profile fetch failed", url, e?.status || e?.message || e);
      }
    }
  }
  const accounts = getAccounts(profile);
  const steam = accounts.find((c) => c.type === "steam" || c.type === "STEAM");
  return steam?.id ?? null;
}
var priceMemo = /* @__PURE__ */ new Map();
var bulkCache = null;
function currencyCode(cur) {
  return {
    1: "USD",
    2: "GBP",
    3: "EUR",
    5: "CHF",
    6: "RUB",
    7: "PLN",
    8: "BRL",
    9: "JPY",
    22: "CAD",
    23: "AUD",
    24: "SGD"
  }[cur] || "USD";
}
async function loadCsfloatBulk() {
  const url = "https://csfloat.com/api/v1/listings/price-list";
  const arr = await fetchJson(url);
  const map = /* @__PURE__ */ new Map();
  for (const it of arr) {
    const name = it?.market_hash_name;
    const cents = it?.min_price;
    if (typeof name === "string" && typeof cents === "number" && cents > 0) {
      map.set(name, cents / 100);
    }
  }
  return map;
}
async function loadSkinportBulk() {
  const kind = settings.store.skinportPriceKind || "suggested_price";
  const url = "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";
  const arr = await fetchJson(url);
  const map = /* @__PURE__ */ new Map();
  for (const it of arr) {
    const name = it?.market_hash_name;
    const p = it?.[kind] ?? it?.suggested_price ?? it?.min_price;
    if (typeof name === "string" && typeof p === "number" && p > 0) map.set(name, p);
  }
  return map;
}
var fxCache = null;
async function getUsdRate(targetCode) {
  if (targetCode === "USD") return 1;
  if (fxCache && fxCache.code === targetCode && Date.now() - fxCache.ts < 6 * 36e5) return fxCache.rate;
  try {
    const data = await fetchJson("https://open.er-api.com/v6/latest/USD");
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
async function getBulkPrices(source) {
  const cur = settings.store.marketCurrency || 1;
  const kind = settings.store.skinportPriceKind || "suggested_price";
  const key = `${source}|${cur}|${kind}`;
  const ttl = (settings.store.priceCacheMinutes || 60) * 6e4;
  if (bulkCache && bulkCache.key === key && Date.now() - bulkCache.ts < ttl) {
    return bulkCache.prices;
  }
  let prices = /* @__PURE__ */ new Map();
  if (source === "csfloat") prices = await loadCsfloatBulk();
  else if (source === "skinport") prices = await loadSkinportBulk();
  const targetCode = currencyCode(cur);
  if (targetCode !== "USD" && prices.size) {
    const rate = await getUsdRate(targetCode);
    if (rate > 0 && rate !== 1) {
      const conv = /* @__PURE__ */ new Map();
      for (const [k, v] of prices) conv.set(k, v * rate);
      prices = conv;
    }
  }
  bulkCache = { key, prices, ts: Date.now() };
  return prices;
}
function parseSteamPrice(raw) {
  const cleaned = String(raw).replace(/[^\d.,]/g, "");
  let normalized;
  if (cleaned.includes(".") && cleaned.includes(",")) {
    normalized = cleaned.replace(/,/g, "");
  } else if (cleaned.includes(",") && !cleaned.includes(".")) {
    normalized = cleaned.replace(",", ".");
  } else {
    normalized = cleaned;
  }
  const n = parseFloat(normalized);
  return isFinite(n) ? n : 0;
}
async function fetchSteamMarketPrice(marketHashName, currency) {
  const key = `${marketHashName}|${currency}`;
  const ttl = (settings.store.priceCacheMinutes || 15) * 6e4;
  const hit = priceMemo.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.price;
  const url = `https://steamcommunity.com/market/priceoverview/?country=US&currency=${currency}&appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
  try {
    const data = await fetchJson(url);
    if (!data?.success) {
      priceMemo.set(key, { price: 0, ts: Date.now() });
      return 0;
    }
    const raw = data.lowest_price ?? data.median_price ?? "";
    const price = parseSteamPrice(raw);
    priceMemo.set(key, { price, ts: Date.now() });
    return price;
  } catch (e) {
    if (String(e?.message || e).includes("429")) throw new Error("Steam rate-limited (429). Wait a minute and re-run.");
    throw e;
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseStickers(desc) {
  const out = [];
  for (const e of desc?.descriptions ?? []) {
    const v = e?.value;
    if (typeof v !== "string" || !v.includes("Sticker:")) continue;
    for (const m of v.matchAll(/title="Sticker: ([^"]+)"/g)) out.push(`Sticker | ${m[1]}`);
  }
  return out;
}
var dopplerIconMap = null;
var dopplerMapPromise = null;
async function getDopplerIconMap() {
  if (dopplerIconMap) return dopplerIconMap;
  if (!dopplerMapPromise) {
    dopplerMapPromise = (async () => {
      const map = /* @__PURE__ */ new Map();
      try {
        const skins = await fetchJson("https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json");
        for (const s of skins) {
          if (!s?.phase || !s?.image || s?.paint_index == null) continue;
          const hash = String(s.image).split("/economy/image/")[1]?.split("/")[0];
          if (hash) map.set(hash, { phase: s.phase, paintIndex: Number(s.paint_index) });
        }
      } catch (e) {
        console.warn("[VSI] Doppler phase map fetch failed \u2014 Dopplers will use generic prices", e);
      }
      dopplerIconMap = map;
      return map;
    })();
  }
  return dopplerMapPromise;
}
var isDopplerName = (name) => /\bDoppler\b/i.test(name);
var phasePriceCache = /* @__PURE__ */ new Map();
async function getCsfloatPhasePrice(marketHashName, paintIndex) {
  const apiKey = (settings.store.csfloatApiKey || "").trim();
  if (!apiKey) return null;
  const cur = settings.store.marketCurrency || 1;
  const cacheKey = `${marketHashName}::${paintIndex}::${cur}`;
  const ttl = (settings.store.priceCacheMinutes || 60) * 6e4;
  const hit = phasePriceCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ttl) return hit.price;
  try {
    const url = `https://csfloat.com/api/v1/listings?sort_by=lowest_price&limit=1&market_hash_name=${encodeURIComponent(marketHashName)}&paint_index=${paintIndex}`;
    const resp = await fetchJson(url, { headers: { Authorization: apiKey } });
    const list = Array.isArray(resp) ? resp : resp?.data ?? [];
    const cents = list[0]?.price;
    if (typeof cents !== "number" || cents <= 0) return null;
    let price = cents / 100;
    const targetCode = currencyCode(cur);
    if (targetCode !== "USD") {
      const r = await getUsdRate(targetCode);
      if (r > 0) price *= r;
    }
    phasePriceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch (e) {
    console.warn("[VSI] CSFloat phase price failed for", marketHashName, paintIndex, e);
    return null;
  }
}
async function loadInventory(steamId, opts) {
  const empty = (isPriv) => ({
    total: 0,
    priced: 0,
    count: 0,
    marketableCount: 0,
    uniqueNames: 0,
    isPrivate: isPriv,
    topItems: [],
    allItems: [],
    owned: {},
    stickerTotal: 0,
    unpriced: [],
    skippedNonMarketable: 0
  });
  const base = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
  const assets = [];
  const descriptions = [];
  const seenDesc = /* @__PURE__ */ new Set();
  let startAssetId;
  let pages = 0;
  try {
    do {
      const url = startAssetId ? `${base}&start_assetid=${startAssetId}` : base;
      const page = await fetchJson(url);
      if (!page?.assets || !page?.descriptions) {
        if (pages === 0) return empty(true);
        break;
      }
      assets.push(...page.assets);
      for (const d of page.descriptions) {
        const k = `${d.classid}_${d.instanceid}`;
        if (!seenDesc.has(k)) {
          seenDesc.add(k);
          descriptions.push(d);
        }
      }
      startAssetId = page.more_items ? String(page.last_assetid) : void 0;
      pages++;
      if (startAssetId) await sleep(600);
    } while (startAssetId && pages < 8);
  } catch (e) {
    if (String(e?.message || e).includes("403")) return empty(true);
    if (assets.length === 0) throw e;
  }
  if (assets.length === 0) return empty(true);
  const inv = { assets, descriptions };
  const dopMap = await getDopplerIconMap();
  const wantStickers = settings.store.includeStickerValue === true;
  const metaByKey = /* @__PURE__ */ new Map();
  for (const d of inv.descriptions) {
    const name = d.market_hash_name;
    const dp = isDopplerName(name) && d.icon_url ? dopMap.get(d.icon_url) ?? null : null;
    metaByKey.set(`${d.classid}_${d.instanceid}`, {
      name,
      marketable: d.marketable === 1 || d.marketable === "1",
      phase: dp?.phase ?? null,
      paintIndex: dp?.paintIndex ?? null,
      icon: d.icon_url ?? "",
      stickers: wantStickers ? parseStickers(d) : []
    });
  }
  const groups = /* @__PURE__ */ new Map();
  const owned = /* @__PURE__ */ new Map();
  let marketableCount = 0;
  let skippedNonMarketable = 0;
  for (const a of inv.assets) {
    const meta = metaByKey.get(`${a.classid}_${a.instanceid}`);
    if (!meta) continue;
    if (!meta.marketable) {
      skippedNonMarketable++;
      continue;
    }
    marketableCount++;
    owned.set(meta.name, (owned.get(meta.name) ?? 0) + 1);
    const stickerSig = meta.stickers.length ? meta.stickers.slice().sort().join("|") : "";
    const gk = `${meta.name}::${meta.phase ?? ""}::${stickerSig}`;
    const g = groups.get(gk);
    if (g) g.qty++;
    else groups.set(gk, { name: meta.name, phase: meta.phase, paintIndex: meta.paintIndex, qty: 1, icon: meta.icon, stickers: meta.stickers });
  }
  const uniqueNames = [...new Set([...groups.values()].map((g) => g.name))];
  const priceByName = /* @__PURE__ */ new Map();
  const misses = [];
  let bulk = /* @__PURE__ */ new Map();
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
  const priceByGroup = /* @__PURE__ */ new Map();
  const stickerByGroup = /* @__PURE__ */ new Map();
  const hasKey = !!(settings.store.csfloatApiKey || "").trim();
  for (const [gk, g] of groups) {
    let base2 = null;
    if (g.phase && g.paintIndex != null && hasKey) {
      base2 = await getCsfloatPhasePrice(g.name, g.paintIndex);
      await sleep(350);
    }
    if (base2 == null) base2 = priceByName.get(g.name) ?? null;
    if (base2 == null) continue;
    const isSouvenir = /^Souvenir /.test(g.name);
    let stickerVal = 0;
    if (!isSouvenir) for (const sn of g.stickers) {
      const sp = bulk.get(sn);
      if (sp && sp > 0) stickerVal += sp;
    }
    priceByGroup.set(gk, base2 + stickerVal);
    if (stickerVal > 0) stickerByGroup.set(gk, { value: stickerVal, count: g.stickers.length });
  }
  const buildResult = () => {
    const unpriced = [];
    for (const [gk, g] of groups) if (!priceByGroup.has(gk)) unpriced.push(g.phase ? `${g.name} (${g.phase})` : g.name);
    let total = 0, priced = 0, stickerTotal = 0;
    const perItem = [];
    for (const [gk, g] of groups) {
      const p = priceByGroup.get(gk);
      if (p == null) continue;
      total += p * g.qty;
      priced += g.qty;
      const sm = stickerByGroup.get(gk);
      if (sm) stickerTotal += sm.value * g.qty;
      perItem.push({ name: g.phase ? `${g.name} (${g.phase})` : g.name, price: p, qty: g.qty, icon: g.icon, stickerValue: sm?.value, stickerCount: sm?.count });
    }
    perItem.sort((a, b) => b.price * b.qty - a.price * a.qty);
    const topItems = perItem.slice(0, 5).map((i) => ({ name: i.qty > 1 ? `${i.name} \xD7${i.qty}` : i.name, price: i.price * i.qty }));
    return { total, priced, count: inv.assets.length, marketableCount, uniqueNames: uniqueNames.length, isPrivate: false, topItems, allItems: perItem, owned: Object.fromEntries(owned), stickerTotal, unpriced: unpriced.slice(0, 5), skippedNonMarketable };
  };
  const shouldRunLive = opts.source === "live_steam" || opts.useLiveFallback && misses.length > 0;
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
      } catch (e) {
        if (String(e?.message || e).includes("429")) {
          console.warn("[VSI] Steam rate-limited \u2014 skipping the remaining live-price fallback");
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
      runFallback().then(() => {
        try {
          opts.onUpdate(buildResult());
        } catch {
        }
      }).catch(() => {
      });
    } else {
      await runFallback();
    }
  }
  return buildResult();
}
function currencySymbol(c) {
  return {
    1: "$",
    2: "\xA3",
    3: "\u20AC",
    5: "CHF ",
    6: "\u20BD",
    7: "z\u0142 ",
    8: "R$",
    9: "\xA5",
    22: "C$",
    23: "A$",
    24: "S$"
  }[c] || "$";
}
var fmt = (n, cur = 1) => `${currencySymbol(cur)}${n.toFixed(2)}`;
function abbrevItem(name) {
  return name.replace(/\(Factory New\)/gi, "(FN)").replace(/\(Minimal Wear\)/gi, "(MW)").replace(/\(Field-Tested\)/gi, "(FT)").replace(/\(Well-Worn\)/gi, "(WW)").replace(/\(Battle-Scarred\)/gi, "(BS)").replace(/StatTrak™\s*/g, "ST ").replace(/Souvenir\s+/g, "Souv ").replace(/★\s*/g, "\u2605 ");
}
var snapKey = (steamId) => `vsi.snap.${steamId}`;
async function getSnapshots(steamId) {
  return await DataStore.get(snapKey(steamId)) ?? [];
}
async function pushSnapshot(steamId, snap) {
  const list = await getSnapshots(steamId);
  list.unshift(snap);
  await DataStore.set(snapKey(steamId), list.slice(0, 20));
}
var itemsKey = (steamId) => `vsi.items.${steamId}`;
async function getItemsSnaps(steamId) {
  return await DataStore.get(itemsKey(steamId)) ?? [];
}
function sameOwned(a, b) {
  if (!a || !b) return false;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}
async function pushItemsSnap(steamId, snap) {
  const list = await getItemsSnaps(steamId);
  const prev = list[0];
  if (prev && sameOwned(prev.owned, snap.owned)) {
    list[0] = snap;
  } else {
    list.unshift(snap);
  }
  await DataStore.set(itemsKey(steamId), list.slice(0, 3));
}
async function buildDiffLine(steamId) {
  const snaps = await getItemsSnaps(steamId);
  if (snaps.length < 2) return null;
  const [cur, prev] = snaps;
  if (!cur.owned || !prev.owned) return null;
  const priceOf = (name) => {
    let best = 0;
    for (const it of cur.items) if (it.name === name || it.name.startsWith(name)) best = Math.max(best, it.price);
    return best;
  };
  const added = [];
  const removed = [];
  for (const [name, q] of Object.entries(cur.owned)) {
    const d = q - (prev.owned[name] ?? 0);
    if (d > 0) added.push({ name, qty: d, price: priceOf(name) });
  }
  for (const [name, q] of Object.entries(prev.owned)) {
    const d = q - (cur.owned[name] ?? 0);
    if (d > 0) removed.push({ name, qty: d, price: priceOf(name) });
  }
  if (!added.length && !removed.length) return null;
  const label = (arr) => {
    const top = arr.slice().sort((a, b) => b.price - a.price).slice(0, 2).map((i) => `${abbrevItem(i.name)}${i.qty > 1 ? ` \xD7${i.qty}` : ""}`);
    return arr.length > 2 ? `${top.join(", ")} +${arr.length - 2} more` : top.join(", ");
  };
  const parts = [];
  if (added.length) parts.push(`gained ${label(added)}`);
  if (removed.length) parts.push(`dropped ${label(removed)}`);
  return `${parts.join(" \xB7 ")} \xB7 ${humanAgo(cur.ts - prev.ts)}`;
}
var CACHE_WORKER = "https://vsi-cache.reap-dev.workers.dev";
var CACHE_FRESH_MS = 25 * 6e4;
async function fxFor(cur) {
  const code = currencyCode(cur);
  return code === "USD" ? 1 : await getUsdRate(code);
}
async function cacheGetInventory(steamId, cur) {
  if (!settings.store.useSharedCache) return null;
  try {
    const data = await fetchJson(`${CACHE_WORKER}/inv/${steamId}`);
    if (!data?.found || typeof data.total_usd !== "number") return null;
    if (Date.now() - (data.ts || 0) > CACHE_FRESH_MS) return null;
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
      topItems: (data.top_items ?? []).map((t) => ({ name: t.name, price: (t.price_usd ?? 0) * fx }))
    };
  } catch {
    return null;
  }
}
async function cachePushInventory(steamId, snap, name) {
  if (!settings.store.useSharedCache) return;
  try {
    const fx = await fxFor(snap.currency || 1);
    if (!fx) return;
    await fetchJson(`${CACHE_WORKER}/inv/${steamId}`, {
      method: "POST",
      body: {
        total_usd: snap.total / fx,
        priced: snap.priced,
        item_count: snap.itemCount,
        marketable_count: snap.marketableCount ?? 0,
        unique_names: snap.uniqueNames,
        top_items: (snap.topItems ?? []).map((t) => ({ name: t.name, price_usd: t.price / fx })),
        ...name ? { name } : {}
      }
    });
  } catch {
  }
}
async function cacheGetLeaderboard(limit, cur) {
  try {
    const data = await fetchJson(`${CACHE_WORKER}/leaderboard?limit=${limit}`);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const fx = await fxFor(cur);
    return entries.map((e) => ({ steamId: String(e.steamId), total: (e.total_usd ?? 0) * fx, name: e.name }));
  } catch {
    return [];
  }
}
async function cachePushTradeUrl() {
  if (!settings.store.useSharedCache) return;
  const tradeUrl = settings.store.tradeUrl?.trim();
  if (!tradeUrl) return;
  const steamId = steamIdFromTradeUrl(tradeUrl);
  if (!steamId) return;
  const method = settings.store.shareTradeUrl === false ? "DELETE" : "POST";
  try {
    await fetchJson(`${CACHE_WORKER}/trade/${steamId}`, { method, body: { trade_url: tradeUrl } });
  } catch {
  }
}
async function cacheGetTradeUrl(steamId) {
  if (!settings.store.useSharedCache) return null;
  try {
    const data = await fetchJson(`${CACHE_WORKER}/trade/${steamId}`);
    return data?.found && typeof data.trade_url === "string" ? data.trade_url : null;
  } catch {
    return null;
  }
}
function humanAgo(ms) {
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
function computeDelta(currentTotal, snaps, minAgeMs) {
  const now = Date.now();
  const prev = snaps.find((s) => now - s.ts >= minAgeMs && s.total !== currentTotal);
  if (!prev) return null;
  return { delta: currentTotal - prev.total, ago: humanAgo(now - prev.ts) };
}
var STEAM_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11.98 2C6.7 2 2.36 6.03 2 11.13l5.38 2.22a2.86 2.86 0 0 1 1.6-.48h.15l2.4-3.47v-.05a3.83 3.83 0 1 1 3.83 3.83h-.09l-3.42 2.44v.13a2.87 2.87 0 0 1-5.42 1.3L2.5 15.5A9.99 9.99 0 0 0 22 12c0-5.52-4.48-10-10.02-10ZM8.79 17.16l-1.22-.5a2.16 2.16 0 0 0 1.15 1.13c1.09.45 2.35-.06 2.8-1.16.22-.53.22-1.11 0-1.64a2.15 2.15 0 0 0-1.14-1.16 2.14 2.14 0 0 0-1.64.01l1.26.52a1.59 1.59 0 1 1-1.21 2.94v-.14Zm10.02-7.6a2.55 2.55 0 0 1-5.11 0 2.55 2.55 0 0 1 5.11 0Zm-4.47 0a1.92 1.92 0 1 0 3.83 0 1.92 1.92 0 0 0-3.83 0Z"/></svg>';
var USER_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-4.42 0-8 2.24-8 5v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2c0-2.76-3.58-5-8-5Z"/></svg>';
var TRADE_URL_RE = /https?:\/\/(?:www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+(?:&(?:amp;)?token=[A-Za-z0-9_-]+)?/i;
function extractTradeUrl(text) {
  if (!text) return null;
  const m = text.match(TRADE_URL_RE);
  if (!m) return null;
  return m[0].replace(/&amp;/g, "&");
}
async function getTradeUrlForUser(userId) {
  const profile = UserProfileStore.getUserProfile(userId);
  let bio = profile?.bio ?? profile?.userProfile?.bio ?? profile?.user_profile?.bio;
  if (!bio) {
    const guildId = SelectedGuildStore?.getGuildId?.() || "";
    const attempts = [];
    if (guildId) attempts.push(`/users/${userId}/profile?guild_id=${guildId}&with_mutual_guilds=false`);
    attempts.push(`/users/${userId}/profile?with_mutual_guilds=false`);
    for (const url of attempts) {
      try {
        const res = await RestAPI.get({ url });
        const body = res?.body;
        bio = body?.user_profile?.bio ?? body?.userProfile?.bio ?? body?.bio;
        if (bio) break;
      } catch {
      }
    }
  }
  return extractTradeUrl(bio ?? null);
}
function steamIdFromTradeUrl(tradeUrl) {
  try {
    const partner = new URL(tradeUrl).searchParams.get("partner");
    if (!partner || !/^\d+$/.test(partner)) return null;
    return (76561197960265728n + BigInt(partner)).toString();
  } catch {
    return null;
  }
}
function deriveSteamProfileUrl(tradeUrl) {
  const steamId64 = steamIdFromTradeUrl(tradeUrl);
  return steamId64 ? `https://steamcommunity.com/profiles/${steamId64}` : null;
}
var BUTTON_CSS = `
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
/* Only rows added from an async network fetch get the slide-in; sync (cache-hit) rows
   are rendered as .vsi-trade-row.instant and skip the animation entirely. */
.vsi-trade-row:not(.instant) {
    animation: vsi-row-in 0.32s cubic-bezier(.16,.84,.44,1) both;
}
@keyframes vsi-row-in {
    from { opacity: 0; transform: translateY(-6px); }
    to   { opacity: 1; transform: translateY(0); }
}
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
       theme (light or dark Nitro gradients) \u2014 never blends into the popout. */
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

/* \u2500\u2500 Full breakdown modal \u2500\u2500 */
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
}
.vsi-modal-row:hover { background: rgba(255,255,255,.04); }
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
`;
var styleEl = null;
var observer = null;
function ensureStyle() {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.id = "vsi-styles";
  styleEl.textContent = BUTTON_CSS;
  document.head.appendChild(styleEl);
}
function buildButton(shownUserId, isOwn, wantTradeRow, wantCard) {
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
    card.className = "vsi-inv-card loading";
    card.dataset.vsiBadge = "1";
    card.innerHTML = `
            <div class="vsi-card-header">
                <span>\u{1F4BC} CS2 Inventory</span>
                <span class="vsi-refresh" title="Loading\u2026">\u21BB</span>
            </div>
            <div class="vsi-value-row"><span class="vsi-skel vsi-skel-value"></span></div>
            <div class="vsi-skel vsi-skel-meta"></div>
            <div class="vsi-top-list">
                <span class="vsi-skel vsi-skel-row"></span>
                <span class="vsi-skel vsi-skel-row"></span>
                <span class="vsi-skel vsi-skel-row"></span>
            </div>
        `;
    card.addEventListener("click", (e) => {
      const t = e.target;
      if (t?.closest?.(".vsi-refresh, .vsi-load-btn")) {
        e.stopPropagation();
        e.preventDefault();
        refreshCard(card, shownUserId, isOwn);
        return;
      }
      if (!card.querySelector(".vsi-value")) return;
      e.stopPropagation();
      openInventoryModalForUser(shownUserId).catch((err) => console.error("[VSI] open modal", err));
    });
    wrap.appendChild(card);
    populateInventoryCard(card, shownUserId, isOwn).catch((e) => console.error("[VSI] populateInventoryCard", e));
  }
  return wrap;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
async function runInventoryForUser(shownUserId, onBackgroundUpdate) {
  const steamId = await getSteamId(shownUserId);
  if (!steamId) throw new Error("no-steam");
  const name = UserStore?.getUser?.(shownUserId)?.username;
  await priceSteamId(steamId, name, onBackgroundUpdate);
}
async function priceSteamId(steamId, name, onBackgroundUpdate) {
  const validSources = /* @__PURE__ */ new Set(["csfloat", "skinport", "live_steam"]);
  const stored = settings.store.priceSource;
  const source = validSources.has(stored) ? stored : "csfloat";
  const useLiveFallback = !!settings.store.useLiveSteamFallback;
  const cur = settings.store.marketCurrency || 1;
  const snapFrom = (r) => ({
    total: r.total,
    priced: r.priced,
    itemCount: r.count,
    marketableCount: r.marketableCount,
    uniqueNames: r.uniqueNames,
    ts: Date.now(),
    source,
    currency: cur,
    topItems: r.topItems,
    stickerTotal: r.stickerTotal
  });
  const saveItems = (r) => pushItemsSnap(steamId, { ts: Date.now(), currency: cur, total: r.total, items: r.allItems, owned: r.owned }).catch(() => {
  });
  const onUpdate = onBackgroundUpdate ? (final) => {
    const s = snapFrom(final);
    pushSnapshot(steamId, s).then(() => {
      saveItems(final);
      cachePushInventory(steamId, s, name);
      onBackgroundUpdate();
    }).catch(() => {
    });
  } : void 0;
  const inv = await loadInventory(steamId, { source, useLiveFallback, onUpdate });
  if (inv.isPrivate) throw new Error("inventory-private");
  const snap = snapFrom(inv);
  await pushSnapshot(steamId, snap);
  await saveItems(inv);
  cachePushInventory(steamId, snap, name);
  return inv;
}
async function refreshCard(card, shownUserId, isOwn) {
  if (card.classList.contains("loading")) return;
  card.classList.add("loading");
  const refresh = card.querySelector(".vsi-refresh");
  const originalTitle = refresh?.title;
  if (refresh) refresh.title = "Refreshing\u2026";
  try {
    await runInventoryForUser(shownUserId, () => {
      if (card.isConnected) populateInventoryCard(card, shownUserId, isOwn).catch(() => {
      });
    });
  } catch (e) {
    console.error("[VSI] refresh failed", e);
    if (e?.message === "no-steam") {
      card.innerHTML = `
                <div class="vsi-card-header"><span>\u{1F4BC} CS2 Inventory</span></div>
                <div class="vsi-empty">No visible Steam account on this profile.</div>
            `;
      card.classList.remove("loading");
      return;
    }
    if (e?.message === "inventory-private") {
      card.innerHTML = `
                <div class="vsi-card-header"><span>\u{1F4BC} CS2 Inventory</span><span class="vsi-refresh" title="Try again">\u21BB</span></div>
                <div class="vsi-empty">Steam inventory is private.</div>
            `;
      card.classList.remove("loading");
      const r = card.querySelector(".vsi-refresh");
      if (r) r.addEventListener("click", () => refreshCard(card, shownUserId, isOwn));
      return;
    }
    if (refresh && originalTitle) refresh.title = originalTitle;
  }
  card.classList.remove("loading");
  await populateInventoryCard(card, shownUserId, isOwn);
}
async function populateInventoryCard(card, shownUserId, isOwn) {
  card.classList.remove("loading");
  const steamId = await getSteamId(shownUserId);
  if (!steamId) {
    card.innerHTML = `
            <div class="vsi-card-header"><span>\u{1F4BC} CS2 Inventory</span></div>
            <div class="vsi-empty">No visible Steam account on this profile.</div>
        `;
    return;
  }
  const snaps = await getSnapshots(steamId);
  let latest = snaps[0];
  if (!latest) {
    const cached = await cacheGetInventory(steamId, settings.store.marketCurrency || 1);
    if (cached) {
      latest = cached;
      pushSnapshot(steamId, cached).catch(() => {
      });
    }
  }
  if (!latest) {
    const who = isOwn ? "your" : "their";
    card.innerHTML = `
            <div class="vsi-card-header"><span>\u{1F4BC} CS2 Inventory</span></div>
            <div class="vsi-empty">No snapshot yet \u2014 load ${who} CS2 inventory to price it.</div>
            <button class="vsi-load-btn" type="button">${STEAM_ICON_SVG}<span>Load inventory</span></button>
        `;
    return;
  }
  const cur = latest.currency || 1;
  const ageMs = Date.now() - latest.ts;
  const staleH = settings.store.snapshotStalenessHours || 0;
  const isStale = staleH > 0 && ageMs > staleH * 36e5;
  if (isStale) card.classList.add("stale");
  let deltaHtml = "";
  if (settings.store.showPriceChange) {
    const minAge = (settings.store.deltaMinAgeMinutes || 60) * 6e4;
    const d = computeDelta(latest.total, snaps.slice(1), minAge);
    if (d) {
      const cls = d.delta > 0 ? "up" : d.delta < 0 ? "down" : "";
      const sign = d.delta >= 0 ? "+" : "";
      deltaHtml = `<span class="vsi-delta ${cls}">${sign}${fmt(d.delta, cur)}</span>`;
    }
  }
  const shortSource = latest.source === "csfloat" ? "CSFloat" : latest.source === "skinport" ? "Skinport" : latest.source === "live_steam" ? "Steam Live" : latest.source;
  const itemCountBit = settings.store.showItemCount ? ` \xB7 ${latest.marketableCount ?? latest.itemCount} items` : "";
  const staleTag = isStale ? '<span class="vsi-stale-tag">STALE</span>' : "";
  const topItems = latest.topItems ?? [];
  const topHtml = topItems.length ? `<div class="vsi-top-list">${topItems.map((i) => `
            <div class="vsi-top-row">
                <span class="vsi-top-name">${escapeHtml(abbrevItem(i.name))}</span>
                <span class="vsi-top-price">${fmt(i.price, cur)}</span>
            </div>
        `).join("")}</div>` : '<div class="vsi-empty">Top items will show after next /inventory run.</div>';
  const changed = await buildDiffLine(steamId);
  const diffHtml = changed ? `<div class="vsi-diff">${escapeHtml(changed)}</div>` : "";
  card.innerHTML = `
        <div class="vsi-card-header">
            <span>\u{1F4BC} CS2 Inventory</span>
            <span class="vsi-refresh" title="Refresh">\u21BB</span>
        </div>
        <div class="vsi-value-row">
            <span class="vsi-value">${fmt(latest.total, cur)}</span>
            ${deltaHtml}
        </div>
        <div class="vsi-meta">${shortSource} \xB7 ${humanAgo(ageMs)}${itemCountBit}${stickerSuffix(latest.stickerTotal, cur)}${staleTag}</div>
        ${topHtml}
        ${diffHtml}
    `;
}
function panelUserId(panel) {
  const withId = panel.querySelector("[data-user-id]");
  if (withId?.dataset.userId) return withId.dataset.userId;
  const img = panel.querySelector('img[src*="/avatars/"], img[src*="/users/"]');
  if (img) {
    const m = img.src.match(/\/(?:avatars|users)\/(\d{15,25})\//);
    if (m) return m[1];
  }
  return null;
}
function findLeaf(root, textRegex) {
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (el.children.length !== 0) continue;
    if (textRegex.test((el.textContent || "").trim())) return el;
  }
  return null;
}
function containerBlock(leaf, boundary) {
  let node = leaf;
  while (node.parentElement && node.parentElement !== boundary && node.offsetHeight < 24) {
    node = node.parentElement;
  }
  while (node.parentElement && node.parentElement !== boundary && node.parentElement.children.length === 1) {
    node = node.parentElement;
  }
  return node;
}
function findInsertionPoint(inner) {
  const gc = findLeaf(inner, /^Game Collection$/i);
  if (gc) {
    const block = containerBlock(gc, inner);
    if (block.parentElement) return { parent: block.parentElement, before: block };
  }
  const vfb = findLeaf(inner, /^View Full Bio$/i);
  if (vfb) {
    const block = containerBlock(vfb, inner);
    if (block.parentElement) return { parent: block.parentElement, before: block.nextSibling };
  }
  const ep = [...inner.querySelectorAll("button, a")].find((b) => /edit\s+profile/i.test(b.textContent || ""));
  if (ep?.parentElement) return { parent: ep.parentElement, before: ep };
  const msgInput = inner.querySelector('[role="textbox"], [contenteditable="true"], [class*="channelTextArea"]');
  if (msgInput) {
    let node = msgInput;
    while (node && node.parentElement && node.parentElement !== inner) node = node.parentElement;
    if (node && node.parentElement === inner) {
      return { parent: inner, before: node };
    }
  }
  return { parent: inner, before: null };
}
function tryInject(panel) {
  if (panel.querySelector('[data-vsi="1"]')) return;
  const shownId = panelUserId(panel);
  if (!shownId) return;
  const myId = UserStore.getCurrentUser()?.id;
  const isOwn = shownId === myId;
  const ownTradeUrl = isOwn ? settings.store.tradeUrl?.trim() : void 0;
  const wantTradeRow = isOwn && !!settings.store.showOnOwnProfile && !!ownTradeUrl;
  const wantCard = !!settings.store.showInventoryOnProfile;
  const canRenderForeignTradeRow = !isOwn && !!settings.store.showInventoryOnProfile;
  if (!wantTradeRow && !wantCard && !canRenderForeignTradeRow) return;
  const inner = panel.querySelector('[class*="inner_"]') ?? panel;
  const target = findInsertionPoint(inner);
  if (!target) return;
  const btn = buildButton(shownId, isOwn, wantTradeRow, wantCard);
  target.parent.insertBefore(btn, target.before);
  if (!isOwn) {
    const sync = resolveForeignSync(shownId);
    if (sync?.tradeUrl) {
      const row = buildForeignRow(sync.tradeUrl, sync.steamId);
      if (row) {
        row.classList.add("instant");
        btn.insertBefore(row, btn.firstChild);
      }
    } else {
      (async () => {
        const bioTradeUrl = sync ? sync.tradeUrl : await getTradeUrlForUser(shownId).catch((e) => {
          console.warn("[VSI] getTradeUrlForUser threw", e);
          return null;
        });
        const steamId = sync?.steamId ?? await getSteamId(shownId).catch((e) => {
          console.warn("[VSI] getSteamId threw", e);
          return null;
        });
        const tradeUrl = bioTradeUrl ?? (steamId ? await cacheGetTradeUrl(steamId).catch(() => null) : null);
        if (!tradeUrl && !steamId) return;
        if (!btn.isConnected) return;
        if (btn.querySelector(".vsi-trade-row")) return;
        const row = buildForeignRow(tradeUrl, steamId);
        if (!row) return;
        btn.insertBefore(row, btn.firstChild);
      })().catch((e) => console.error("[VSI] foreign row outer", e));
    }
  }
}
function resolveForeignSync(shownId) {
  const profile = UserProfileStore.getUserProfile(shownId);
  if (!profile) return null;
  const accounts = profile?.connectedAccounts || profile?.connected_accounts || [];
  const steamId = accounts.find((c) => c?.type === "steam" || c?.type === "STEAM")?.id ?? null;
  const bioText = profile?.bio ?? profile?.userProfile?.bio ?? profile?.user_profile?.bio;
  const tradeUrl = extractTradeUrl(bioText ?? null);
  if (!tradeUrl && !steamId) return null;
  return { tradeUrl, steamId };
}
function buildForeignRow(tradeUrl, steamId) {
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
  const profileUrl = tradeUrl ? deriveSteamProfileUrl(tradeUrl) : steamId ? `https://steamcommunity.com/profiles/${steamId}` : null;
  if (profileUrl) {
    const prof = document.createElement("a");
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
var steamThumb = (icon) => `https://community.akamai.steamstatic.com/economy/image/${icon}/48x48`;
var modalKeyHandler = null;
function closeInventoryModal() {
  document.querySelector(".vsi-modal-backdrop")?.remove();
  if (modalKeyHandler) {
    document.removeEventListener("keydown", modalKeyHandler);
    modalKeyHandler = null;
  }
}
async function openInventoryModal(steamId, displayName) {
  closeInventoryModal();
  const cur = settings.store.marketCurrency || 1;
  const backdrop = document.createElement("div");
  backdrop.className = "vsi-modal-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeInventoryModal();
  });
  const modal = document.createElement("div");
  modal.className = "vsi-modal";
  modal.innerHTML = `
        <div class="vsi-modal-head">
            <span class="vsi-modal-title"><b>${escapeHtml(displayName)}</b> \u2014 CS2 Inventory</span>
            <span class="vsi-modal-total"></span>
            <button class="vsi-modal-x" title="Close">\xD7</button>
        </div>
        <div class="vsi-modal-tools">
            <input class="vsi-modal-search" type="text" placeholder="Search items\u2026" />
            <button class="vsi-modal-sort">Sort: Value</button>
        </div>
        <div class="vsi-modal-list"><div class="vsi-modal-empty">Loading\u2026</div></div>
    `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector(".vsi-modal-x").addEventListener("click", closeInventoryModal);
  modalKeyHandler = (e) => {
    if (e.key === "Escape") closeInventoryModal();
  };
  document.addEventListener("keydown", modalKeyHandler);
  const totalEl = modal.querySelector(".vsi-modal-total");
  const listEl = modal.querySelector(".vsi-modal-list");
  const searchEl = modal.querySelector(".vsi-modal-search");
  const sortEl = modal.querySelector(".vsi-modal-sort");
  let items = [];
  let total = 0;
  let note = "";
  let loading = true;
  let sortMode = "value";
  let query = "";
  const render = () => {
    totalEl.textContent = items.length ? fmt(total, cur) : "";
    if (loading) {
      listEl.innerHTML = '<div class="vsi-modal-empty">Loading full inventory\u2026</div>';
      return;
    }
    if (!items.length) {
      listEl.innerHTML = `<div class="vsi-modal-empty">Couldn't load this inventory \u2014 it may be private.</div>`;
      return;
    }
    const filtered = items.filter((i) => !query || abbrevItem(i.name).toLowerCase().includes(query));
    filtered.sort((a, b) => sortMode === "value" ? b.price * b.qty - a.price * a.qty : abbrevItem(a.name).localeCompare(abbrevItem(b.name)));
    if (!filtered.length) {
      listEl.innerHTML = '<div class="vsi-modal-empty">No items match your search.</div>';
      return;
    }
    const rows = filtered.map((i) => {
      const sv = (i.stickerValue ?? 0) * i.qty;
      const badge = i.stickerCount ? `<span class="vsi-modal-sticker${sv >= 50 ? " grail" : ""}" title="${i.stickerCount} sticker${i.stickerCount > 1 ? "s" : ""}">+${fmt(sv, cur)}</span>` : "";
      return `
            <div class="vsi-modal-row">
                ${i.icon ? `<img class="vsi-modal-thumb" src="${steamThumb(i.icon)}" loading="lazy" />` : '<div class="vsi-modal-thumb"></div>'}
                <span class="vsi-modal-name">${escapeHtml(abbrevItem(i.name))}</span>
                ${badge}
                ${i.qty > 1 ? `<span class="vsi-modal-qty">\xD7${i.qty}</span>` : ""}
                <span class="vsi-modal-price">${fmt(i.price * i.qty, cur)}</span>
            </div>`;
    }).join("");
    listEl.innerHTML = (note ? `<div class="vsi-modal-empty">${escapeHtml(note)}</div>` : "") + rows;
  };
  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    render();
  });
  sortEl.addEventListener("click", () => {
    sortMode = sortMode === "value" ? "name" : "value";
    sortEl.textContent = sortMode === "value" ? "Sort: Value" : "Sort: Name";
    render();
  });
  render();
  searchEl.focus();
  const local = (await getItemsSnaps(steamId))[0];
  if (!backdrop.isConnected) return;
  if (local?.items?.length) {
    items = local.items;
    total = local.total;
    loading = false;
    render();
    return;
  }
  try {
    const inv = await priceSteamId(steamId, void 0, () => {
      getItemsSnaps(steamId).then((s) => {
        if (backdrop.isConnected && s[0]?.items?.length) {
          items = s[0].items;
          total = s[0].total;
          render();
        }
      }).catch(() => {
      });
    });
    if (!backdrop.isConnected) return;
    items = inv.allItems;
    total = inv.total;
    loading = false;
    render();
  } catch {
    if (!backdrop.isConnected) return;
    loading = false;
    const snap = (await getSnapshots(steamId))[0] ?? await cacheGetInventory(steamId, cur);
    if (snap?.topItems?.length) {
      items = snap.topItems.map((t) => ({ name: t.name, price: t.price, qty: 1 }));
      total = snap.total;
      note = "Top items only \u2014 this inventory couldn't be fully loaded.";
    }
    render();
  }
}
async function openInventoryModalForUser(shownUserId) {
  const steamId = await getSteamId(shownUserId);
  if (!steamId) return;
  const name = UserStore?.getUser?.(shownUserId)?.username ?? "CS2 Inventory";
  await openInventoryModal(steamId, name);
}
var unpatchContextMenu = null;
function registerContextMenu() {
  if (!BD.ContextMenu?.patch) return;
  unpatchContextMenu = BD.ContextMenu.patch("user-context", (ret, props) => {
    try {
      const userId = props?.user?.id;
      if (!userId || !ret?.props?.children) return ret;
      const item = BD.ContextMenu.buildItem({
        id: "vsi-inventory",
        label: "CS2 Inventory",
        action: () => {
          openInventoryModalForUser(userId).catch((e) => console.error("[VSI] ctx modal", e));
        }
      });
      const kids = ret.props.children;
      if (Array.isArray(kids)) kids.push(item);
      else ret.props.children = [kids, item];
    } catch (e) {
      console.error("[VSI] context menu patch", e);
    }
    return ret;
  });
}
function unregisterContextMenu() {
  try {
    unpatchContextMenu?.();
  } catch {
  }
  unpatchContextMenu = null;
}
function scan(root) {
  const sel = '[class*="user-profile-popout"], [class~="user-profile-popout"], [class*="userPopout"], [class*="userProfile"], [class*="userPanelOuter"], [class*="profilePanel"]';
  if (root instanceof HTMLElement && root.matches(sel)) tryInject(root);
  root.querySelectorAll(sel).forEach(tryInject);
}
function startObserver() {
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes)) {
        if (n instanceof HTMLElement) scan(n);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan(document.body);
}
function prettyName(id) {
  return id.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}
function buildSettingsPanel() {
  const items = Object.entries(SETTINGS_SCHEMA).map(([id, def]) => {
    const base = { id, name: prettyName(id), note: def.description, value: settings.store[id] };
    if (def.type === OptionType.BOOLEAN) return { ...base, type: "switch" };
    if (def.type === OptionType.NUMBER) return { ...base, type: "number" };
    if (def.type === OptionType.SELECT) {
      return { ...base, type: "dropdown", options: (def.options || []).map((o) => ({ label: o.label, value: o.value })) };
    }
    return { ...base, type: "text", placeholder: def.placeholder || "" };
  });
  return BD.UI.buildSettingsPanel({
    settings: items,
    onChange: (_cat, id, value) => {
      settings.store[id] = value;
      if (id === "tradeUrl" || id === "useSharedCache" || id === "shareTradeUrl") cachePushTradeUrl().catch(() => {
      });
    }
  });
}
var stickerSuffix = (stickerTotal, cur) => stickerTotal && stickerTotal > 0 ? ` \xB7 incl. ${fmt(stickerTotal, cur)} stickers` : "";
function invMarkdown(displayName, r, cur, steamId, tradeUrl, changed) {
  const top = r.topItems ?? [];
  const sym = currencySymbol(cur);
  const nums = top.map((i) => i.price.toFixed(2));
  const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
  const body = top.map((i, k) => `${sym}${nums[k].padStart(w)}  ${abbrevItem(i.name)}`).join("\n");
  const untr = (r.skippedNonMarketable ?? 0) > 0 ? ` \xB7 ${r.skippedNonMarketable} untradeable` : "";
  const links = [
    steamId ? `Steam \xB7 <https://steamcommunity.com/profiles/${steamId}>` : "",
    tradeUrl ? `Trade \xB7 <${tradeUrl}>` : ""
  ].filter(Boolean).join("\n-# ");
  return `## ${displayName} \u2014 ${fmt(r.total, cur)}
-# ${r.priced}/${r.marketableCount ?? r.priced} priced \xB7 ${r.uniqueNames} unique${untr}${stickerSuffix(r.stickerTotal, cur)}` + (changed ? `
-# ${changed}` : "") + (body ? `
\`\`\`
${body}
\`\`\`` : "") + (links ? `
-# ${links}` : "");
}
function invEmbed(displayName, r, cur, steamId, tradeUrl, changed) {
  const sym = currencySymbol(cur);
  const top = r.topItems ?? [];
  const nums = top.map((i) => i.price.toFixed(2));
  const w = nums.reduce((a, s) => Math.max(a, s.length), 0);
  const body = top.map((i, k) => `${sym}${nums[k].padStart(w)}  ${abbrevItem(i.name)}`).join("\n");
  const untr = (r.skippedNonMarketable ?? 0) > 0 ? ` \xB7 ${r.skippedNonMarketable} untradeable` : "";
  const linkParts = [];
  if (steamId) linkParts.push(`[Steam Profile](https://steamcommunity.com/profiles/${steamId})`);
  if (tradeUrl) linkParts.push(`[Send Trade Offer](${tradeUrl})`);
  let description = `${r.priced}/${r.marketableCount ?? r.priced} priced \xB7 ${r.uniqueNames} unique${untr}${stickerSuffix(r.stickerTotal, cur)}`;
  if (changed) description += `
*${changed}*`;
  if (body) description += `
\`\`\`
${body}
\`\`\``;
  if (linkParts.length) description += `
${linkParts.join("  \xB7  ")}`;
  return { color: 5793266, title: `${displayName} \u2014 ${fmt(r.total, cur)}`, description };
}
async function buildInventoryData(args) {
  const userId = args.find((a) => a.name === "user")?.value;
  const steamRef = String(args.find((a) => a.name === "steam")?.value ?? "").trim();
  const d = await priceRef(userId, steamRef);
  if ("error" in d) return d;
  return { ...d, changed: await buildDiffLine(d.steamId) ?? void 0 };
}
async function priceRef(userId, steamRef) {
  let steamId = null;
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
  const tradeUrl = await cacheGetTradeUrl(steamId) ?? void 0;
  const cached = await cacheGetInventory(steamId, cur);
  if (cached) return { displayName, r: cached, cur, steamId, tradeUrl };
  const validSources = /* @__PURE__ */ new Set(["csfloat", "skinport", "live_steam"]);
  const stored = settings.store.priceSource;
  const source = validSources.has(stored) ? stored : "csfloat";
  const inv = await loadInventory(steamId, { source, useLiveFallback: false });
  if (inv.isPrivate) return { error: `**${displayName}**'s Steam inventory is private.` };
  cachePushInventory(steamId, { total: inv.total, priced: inv.priced, itemCount: inv.count, marketableCount: inv.marketableCount, uniqueNames: inv.uniqueNames, ts: Date.now(), source, currency: cur, topItems: inv.topItems }, displayName);
  return { displayName, r: inv, cur, steamId, tradeUrl };
}
function deliver(ctx, markdown, embed) {
  if (settings.store.postPublicly && MessageActions?.sendMessage) {
    const channelId = ctx?.channel?.id ?? SelectedChannelStore?.getChannelId?.();
    if (channelId) {
      MessageActions.sendMessage(channelId, { content: markdown, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, void 0, { nonce: String(Date.now()) });
      return void 0;
    }
  }
  return { embeds: [embed] };
}
async function buildLeaderboard(limit) {
  const cur = settings.store.marketCurrency || 1;
  const rows = await cacheGetLeaderboard(limit, cur);
  if (!rows.length) return { error: "No inventories tracked yet \u2014 run `/inventory` on someone to seed the leaderboard." };
  await Promise.all(rows.map(async (r) => {
    if (!r.name) {
      const resolved = await resolveSteamRef(r.steamId).catch(() => null);
      r.name = resolved?.persona || `SteamID \u2026${r.steamId.slice(-5)}`;
    }
  }));
  return { rows, cur };
}
function lbBody(rows, cur) {
  const totals = rows.map((r) => fmt(r.total, cur));
  const tw = totals.reduce((a, s) => Math.max(a, s.length), 0);
  const rw = String(rows.length).length;
  return rows.map((r, i) => `${String(i + 1).padStart(rw)}. ${totals[i].padStart(tw)}  ${r.name}`).join("\n");
}
function leaderboardMarkdown(rows, cur) {
  return `## CS2 Inventory Leaderboard
-# richest tracked inventories
\`\`\`
${lbBody(rows, cur)}
\`\`\``;
}
function leaderboardEmbed(rows, cur) {
  return { color: 5793266, title: "CS2 Inventory Leaderboard", description: `\`\`\`
${lbBody(rows, cur)}
\`\`\``, footer: { text: "richest tracked inventories" } };
}
async function buildCompare(args) {
  const aUser = args.find((x) => x.name === "a")?.value;
  const aSteam = String(args.find((x) => x.name === "a_steam")?.value ?? "").trim();
  const bUser = args.find((x) => x.name === "b")?.value;
  const bSteam = String(args.find((x) => x.name === "b_steam")?.value ?? "").trim();
  if (!aUser && !aSteam || !bUser && !bSteam) return { error: "Give me **two** sides \u2014 `a` and `b` (each a Discord user or a Steam ref)." };
  const [da, db] = await Promise.all([priceRef(aUser, aSteam), priceRef(bUser, bSteam)]);
  if ("error" in da) return { error: `First: ${da.error}` };
  if ("error" in db) return { error: `Second: ${db.error}` };
  return { a: { displayName: da.displayName, total: da.r.total }, b: { displayName: db.displayName, total: db.r.total }, cur: da.cur };
}
function compareVerdict(a, b, cur) {
  const diff = Math.abs(a.total - b.total);
  if (diff < 5e-3) return "Dead tie.";
  const winner = a.total > b.total ? a : b;
  return `${winner.displayName} wins by ${fmt(diff, cur)}`;
}
function compareBody(a, b, cur) {
  const nw = Math.max(a.displayName.length, b.displayName.length);
  const line = (s) => `${s.displayName.padEnd(nw)}  ${fmt(s.total, cur)}`;
  return `${line(a)}
${line(b)}`;
}
function compareMarkdown(a, b, cur) {
  return `## ${a.displayName} vs ${b.displayName}
\`\`\`
${compareBody(a, b, cur)}
\`\`\`
-# ${compareVerdict(a, b, cur)}`;
}
function compareEmbed(a, b, cur) {
  return { color: 5793266, title: `${a.displayName} vs ${b.displayName}`, description: `\`\`\`
${compareBody(a, b, cur)}
\`\`\``, footer: { text: compareVerdict(a, b, cur) } };
}
function registerCommands() {
  try {
    BD.Commands?.register?.(PLUGIN_NAME, {
      id: "inventory",
      name: "inventory",
      description: "Show a CS2 inventory value in chat \u2014 pick a user or paste a Steam ref",
      options: [
        { name: "user", description: "Discord user (uses their linked Steam)", type: 6, required: false },
        { name: "steam", description: "OR a Steam profile URL / vanity / SteamID64", type: 3, required: false }
      ],
      execute: async (cmdArgs, ctx) => {
        try {
          const d = await buildInventoryData(cmdArgs ?? []);
          if ("error" in d) return { content: d.error };
          return deliver(ctx, invMarkdown(d.displayName, d.r, d.cur, d.steamId, d.tradeUrl, d.changed), invEmbed(d.displayName, d.r, d.cur, d.steamId, d.tradeUrl, d.changed));
        } catch (e) {
          console.error("[VSI] /inventory", e);
          return { content: "Error pricing that inventory \u2014 try again in a moment." };
        }
      }
    });
    BD.Commands?.register?.(PLUGIN_NAME, {
      id: "leaderboard",
      name: "leaderboard",
      description: "Richest CS2 inventories the addon has priced",
      options: [
        { name: "count", description: "How many to show (default 10, max 25)", type: 4, required: false }
      ],
      execute: async (cmdArgs, ctx) => {
        try {
          const raw = Number(cmdArgs?.find((a) => a.name === "count")?.value);
          const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 10, 1), 25);
          const d = await buildLeaderboard(limit);
          if ("error" in d) return { content: d.error };
          return deliver(ctx, leaderboardMarkdown(d.rows, d.cur), leaderboardEmbed(d.rows, d.cur));
        } catch (e) {
          console.error("[VSI] /leaderboard", e);
          return { content: "Couldn't load the leaderboard \u2014 try again in a moment." };
        }
      }
    });
    BD.Commands?.register?.(PLUGIN_NAME, {
      id: "compare",
      name: "compare",
      description: "Compare two CS2 inventories side by side",
      options: [
        { name: "a", description: "First Discord user", type: 6, required: false },
        { name: "b", description: "Second Discord user", type: 6, required: false },
        { name: "a_steam", description: "OR first Steam ref (URL / vanity / SteamID64)", type: 3, required: false },
        { name: "b_steam", description: "OR second Steam ref", type: 3, required: false }
      ],
      execute: async (cmdArgs, ctx) => {
        try {
          const d = await buildCompare(cmdArgs ?? []);
          if ("error" in d) return { content: d.error };
          return deliver(ctx, compareMarkdown(d.a, d.b, d.cur), compareEmbed(d.a, d.b, d.cur));
        } catch (e) {
          console.error("[VSI] /compare", e);
          return { content: "Couldn't compare those \u2014 try again in a moment." };
        }
      }
    });
  } catch (e) {
    console.warn("[VSI] command registration failed (BdApi.Commands unavailable?)", e);
  }
}
function unregisterCommands() {
  try {
    BD.Commands?.unregisterAll?.(PLUGIN_NAME);
  } catch {
  }
}
module.exports = class SteamInventoryValue {
  start() {
    try {
      ensureStyle();
    } catch (e) {
      console.error("[VSI] ensureStyle", e);
    }
    try {
      startObserver();
    } catch (e) {
      console.error("[VSI] startObserver", e);
    }
    try {
      registerCommands();
    } catch (e) {
      console.error("[VSI] registerCommands", e);
    }
    try {
      registerContextMenu();
    } catch (e) {
      console.error("[VSI] registerContextMenu", e);
    }
    try {
      cachePushTradeUrl().catch(() => {
      });
    } catch (e) {
      console.error("[VSI] cachePushTradeUrl", e);
    }
  }
  stop() {
    observer?.disconnect();
    observer = null;
    styleEl?.remove();
    styleEl = null;
    unregisterCommands();
    unregisterContextMenu();
    closeInventoryModal();
    document.querySelectorAll('[data-vsi="1"]').forEach((n) => n.remove());
  }
  getSettingsPanel() {
    return buildSettingsPanel();
  }
};
