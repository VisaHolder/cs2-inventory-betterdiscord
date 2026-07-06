/**
 * @name SteamInventoryValue
 * @author VisaHolder
 * @description CS2 inventory value on Discord profile popouts — Doppler/Gamma phase pricing (CSFloat), FX-converted prices, and Trade Offer / Steam buttons.
 * @version 1.0.0
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
var RestAPI;
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
  RestAPI = Webpack.getByKeys && Webpack.getByKeys("getAPIBaseURL", "get", "post") || Webpack.getModule((m) => m?.getAPIBaseURL && typeof m?.get === "function" && typeof m?.post === "function");
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
var SETTINGS_SCHEMA = {
  tradeUrl: {
    type: OptionType.STRING,
    description: "Your Steam trade offer URL. Grab it from steamcommunity.com/my/tradeoffers/privacy \u2014 this is what the Trade button opens.",
    default: "",
    placeholder: "https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
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
  const metaByKey = /* @__PURE__ */ new Map();
  for (const d of inv.descriptions) {
    const name = d.market_hash_name;
    const dp = isDopplerName(name) && d.icon_url ? dopMap.get(d.icon_url) ?? null : null;
    metaByKey.set(`${d.classid}_${d.instanceid}`, {
      name,
      marketable: d.marketable === 1 || d.marketable === "1",
      phase: dp?.phase ?? null,
      paintIndex: dp?.paintIndex ?? null
    });
  }
  const groups = /* @__PURE__ */ new Map();
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
    const gk = meta.phase ? `${meta.name}::${meta.phase}` : meta.name;
    const g = groups.get(gk);
    if (g) g.qty++;
    else groups.set(gk, { name: meta.name, phase: meta.phase, paintIndex: meta.paintIndex, qty: 1 });
  }
  const uniqueNames = [...new Set([...groups.values()].map((g) => g.name))];
  const priceByName = /* @__PURE__ */ new Map();
  const misses = [];
  if (opts.source !== "live_steam") {
    const bulk = await getBulkPrices(opts.source);
    for (const name of uniqueNames) {
      const p = bulk.get(name);
      if (p && p > 0) priceByName.set(name, p);
      else misses.push(name);
    }
  } else {
    misses.push(...uniqueNames);
  }
  const priceByGroup = /* @__PURE__ */ new Map();
  const hasKey = !!(settings.store.csfloatApiKey || "").trim();
  for (const [gk, g] of groups) {
    let p = null;
    if (g.phase && g.paintIndex != null && hasKey) {
      p = await getCsfloatPhasePrice(g.name, g.paintIndex);
      await sleep(350);
    }
    if (p == null) p = priceByName.get(g.name) ?? null;
    if (p != null) priceByGroup.set(gk, p);
  }
  const buildResult = () => {
    const unpriced = [];
    for (const [gk, g] of groups) if (!priceByGroup.has(gk)) unpriced.push(g.phase ? `${g.name} (${g.phase})` : g.name);
    let total = 0, priced = 0;
    const perItem = [];
    for (const [gk, g] of groups) {
      const p = priceByGroup.get(gk);
      if (p == null) continue;
      total += p * g.qty;
      priced += g.qty;
      perItem.push({ name: g.phase ? `${g.name} (${g.phase})` : g.name, price: p, qty: g.qty });
    }
    perItem.sort((a, b) => b.price * b.qty - a.price * a.qty);
    const topItems = perItem.slice(0, 5).map((i) => ({ name: i.qty > 1 ? `${i.name} \xD7${i.qty}` : i.name, price: i.price * i.qty }));
    return { total, priced, count: inv.assets.length, marketableCount, uniqueNames: uniqueNames.length, isPrivate: false, topItems, unpriced: unpriced.slice(0, 5), skippedNonMarketable };
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
async function cachePushInventory(steamId, snap) {
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
        top_items: (snap.topItems ?? []).map((t) => ({ name: t.name, price_usd: t.price / fx }))
      }
    });
  } catch {
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
function deriveSteamProfileUrl(tradeUrl) {
  try {
    const u = new URL(tradeUrl);
    const partner = u.searchParams.get("partner");
    if (!partner || !/^\d+$/.test(partner)) return null;
    const steamId64 = (76561197960265728n + BigInt(partner)).toString();
    return `https://steamcommunity.com/profiles/${steamId64}`;
  } catch {
    return null;
  }
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
      const hit = t?.closest?.(".vsi-refresh, .vsi-load-btn");
      if (hit) {
        e.stopPropagation();
        e.preventDefault();
        refreshCard(card, shownUserId, isOwn);
      }
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
    topItems: r.topItems
  });
  const onUpdate = onBackgroundUpdate ? (final) => {
    const s = snapFrom(final);
    pushSnapshot(steamId, s).then(() => {
      cachePushInventory(steamId, s);
      onBackgroundUpdate();
    }).catch(() => {
    });
  } : void 0;
  const inv = await loadInventory(steamId, { source, useLiveFallback, onUpdate });
  if (inv.isPrivate) throw new Error("inventory-private");
  const snap = snapFrom(inv);
  await pushSnapshot(steamId, snap);
  cachePushInventory(steamId, snap);
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
  card.innerHTML = `
        <div class="vsi-card-header">
            <span>\u{1F4BC} CS2 Inventory</span>
            <span class="vsi-refresh" title="Refresh">\u21BB</span>
        </div>
        <div class="vsi-value-row">
            <span class="vsi-value">${fmt(latest.total, cur)}</span>
            ${deltaHtml}
        </div>
        <div class="vsi-meta">${shortSource} \xB7 ${humanAgo(ageMs)}${itemCountBit}${staleTag}</div>
        ${topHtml}
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
    if (sync) {
      const row = buildForeignRow(sync.tradeUrl, sync.steamId);
      if (row) {
        row.classList.add("instant");
        btn.insertBefore(row, btn.firstChild);
      }
    } else {
      (async () => {
        const [bioTradeUrl, discordSteamId] = await Promise.all([
          getTradeUrlForUser(shownId).catch((e) => {
            console.warn("[VSI] getTradeUrlForUser threw", e);
            return null;
          }),
          getSteamId(shownId).catch((e) => {
            console.warn("[VSI] getSteamId threw", e);
            return null;
          })
        ]);
        if (!bioTradeUrl && !discordSteamId) return;
        if (!btn.isConnected) return;
        if (btn.querySelector(".vsi-trade-row")) return;
        const row = buildForeignRow(bioTradeUrl, discordSteamId);
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
    }
  });
}
module.exports = class SteamInventoryValue {
  start() {
    ensureStyle();
    startObserver();
  }
  stop() {
    observer?.disconnect();
    observer = null;
    styleEl?.remove();
    styleEl = null;
    document.querySelectorAll('[data-vsi="1"]').forEach((n) => n.remove());
  }
  getSettingsPanel() {
    return buildSettingsPanel();
  }
};
