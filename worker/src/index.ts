/*
 * vsi-cache — shared cache for the SteamInventoryValue plugin.
 *
 * Keyed by PUBLIC SteamID64. Stores two public things, no Discord identity:
 *   • inventory value  (a read-through cache — read before pricing, write after, so once
 *     anyone prices a profile every other viewer loads it instantly, and phase-accurate
 *     Doppler prices from whoever holds a CSFloat key propagate to everyone else)
 *   • trade-offer URL  (published by the owner from plugin settings, so every other addon
 *     user sees a Trade button on that person's profile even without it in their bio)
 *
 * Inventory values are stored in USD; each client applies its own FX at render time, so
 * users on different currencies share one entry.
 *
 *   GET  /inv/:steamid    → { found:true, total_usd, top_items, ..., trade_url?, ts } | { found:false } (404)
 *   POST /inv/:steamid    → { ok:true }            body: { total_usd, top_items, item_count, ... }
 *   GET  /trade/:steamid  → { found:true, trade_url, ts } | { found:false } (404)
 *   POST /trade/:steamid  → { ok:true }            body: { trade_url }   (partner must match :steamid)
 *   GET  /health · /      → { ok:true, service }
 */

export interface Env {
    INV: KVNamespace;
}

const TTL_SECONDS = 30 * 60;            // how long a cached valuation lives
const TRADE_TTL_SECONDS = 180 * 24 * 60 * 60; // trade URLs change rarely — keep them ~6 months
const MAX_TOP_ITEMS = 6;
const MAX_NAME_LEN = 120;
const MAX_TRADE_URL_LEN = 200;

const CORS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
};

const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

const isSteamId = (s: string): boolean => /^\d{17}$/.test(s);
const num = (v: unknown, fallback = 0): number =>
    (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

// Derive the SteamID64 a trade URL belongs to, from its `partner` (32-bit account id).
function steamIdFromTradeUrl(tradeUrl: string): string | null {
    try {
        const p = new URL(tradeUrl).searchParams.get("partner");
        if (!p || !/^\d+$/.test(p)) return null;
        return (76561197960265728n + BigInt(p)).toString();
    } catch { return null; }
}

interface TopItem { name: string; price_usd: number }
interface CacheRecord {
    total_usd: number;
    top_items: TopItem[];
    item_count: number;
    marketable_count: number;
    unique_names: number;
    priced: number;
    ts: number;
}

function sanitize(body: any): CacheRecord | null {
    if (!body || typeof body !== "object") return null;
    if (typeof body.total_usd !== "number" || !Number.isFinite(body.total_usd)) return null;
    const top: TopItem[] = Array.isArray(body.top_items)
        ? body.top_items
            .filter((t: any) => t && typeof t.name === "string" && typeof t.price_usd === "number")
            .slice(0, MAX_TOP_ITEMS)
            .map((t: any) => ({ name: String(t.name).slice(0, MAX_NAME_LEN), price_usd: num(t.price_usd) }))
        : [];
    return {
        total_usd: num(body.total_usd),
        top_items: top,
        item_count: num(body.item_count),
        marketable_count: num(body.marketable_count),
        unique_names: num(body.unique_names),
        priced: num(body.priced),
        ts: Date.now(),
    };
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

        const url = new URL(req.url);
        const [root, steamId] = url.pathname.split("/").filter(Boolean);

        if (!root || root === "health") return json({ ok: true, service: "vsi-cache" });

        if (root === "inv" && steamId) {
            if (!isSteamId(steamId)) return json({ error: "invalid steamid" }, 400);
            const key = `inv:${steamId}`;

            if (req.method === "GET") {
                const raw = await env.INV.get(key);
                if (!raw) return json({ found: false }, 404);
                try {
                    const rec = JSON.parse(raw) as CacheRecord;
                    // Fold in the owner-published trade URL (separate key, long-lived) if present.
                    const trade = await env.INV.get(`trade:${steamId}`);
                    const trade_url = trade ? (JSON.parse(trade).trade_url as string) : undefined;
                    return json({ found: true, ...rec, ...(trade_url ? { trade_url } : {}) });
                } catch {
                    return json({ found: false }, 404);
                }
            }

            if (req.method === "POST") {
                const rec = sanitize(await req.json().catch(() => null));
                if (!rec) return json({ error: "invalid body" }, 400);
                await env.INV.put(key, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
                return json({ ok: true });
            }

            return json({ error: "method not allowed" }, 405);
        }

        if (root === "trade" && steamId) {
            if (!isSteamId(steamId)) return json({ error: "invalid steamid" }, 400);
            const key = `trade:${steamId}`;

            if (req.method === "GET") {
                const raw = await env.INV.get(key);
                if (!raw) return json({ found: false }, 404);
                try {
                    return json({ found: true, ...JSON.parse(raw) });
                } catch {
                    return json({ found: false }, 404);
                }
            }

            if (req.method === "POST") {
                const body: any = await req.json().catch(() => null);
                const tradeUrl = typeof body?.trade_url === "string" ? body.trade_url.trim() : "";
                if (!tradeUrl || tradeUrl.length > MAX_TRADE_URL_LEN) return json({ error: "invalid trade url" }, 400);
                // Integrity: a trade URL can only be filed under the SteamID its `partner` resolves to,
                // so nobody can publish a trade URL for someone else's profile.
                if (steamIdFromTradeUrl(tradeUrl) !== steamId) return json({ error: "partner mismatch" }, 403);
                await env.INV.put(key, JSON.stringify({ trade_url: tradeUrl, ts: Date.now() }), { expirationTtl: TRADE_TTL_SECONDS });
                return json({ ok: true });
            }

            return json({ error: "method not allowed" }, 405);
        }

        return json({ error: "not found", path: url.pathname }, 404);
    },
};
