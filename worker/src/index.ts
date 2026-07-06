/*
 * vsi-cache — shared CS2 inventory-value cache for the SteamInventoryValue plugin.
 *
 * Keyed by PUBLIC SteamID64 and stores only public inventory-value data — no Discord
 * identities, no trade URLs. It's a read-through cache: the plugin reads before pricing
 * and writes back after, so once anyone prices a profile, every other viewer loads it
 * instantly, and phase-accurate Doppler prices (from whoever holds a CSFloat key)
 * propagate to everyone else.
 *
 * Values are stored in USD; each client applies its own FX at render time, so users on
 * different currencies share one cache entry.
 *
 *   GET  /inv/:steamid  → { found:true, total_usd, top_items, item_count, ..., ts } | { found:false } (404)
 *   POST /inv/:steamid  → { ok:true }         body: { total_usd, top_items, item_count, ... }
 *   GET  /health · /    → { ok:true, service }
 */

export interface Env {
    INV: KVNamespace;
}

const TTL_SECONDS = 30 * 60;   // how long a cached valuation lives
const MAX_TOP_ITEMS = 6;
const MAX_NAME_LEN = 120;

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
                    return json({ found: true, ...(JSON.parse(raw) as CacheRecord) });
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

        return json({ error: "not found", path: url.pathname }, 404);
    },
};
