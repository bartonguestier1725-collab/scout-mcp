/**
 * bazaar_search – x402 Bazaar API directory search
 *
 * CDP Discovery API から x402 対応 API の一覧を取得し、
 * テキスト検索を提供する。
 *
 * - 起動時に上位 500 件をクロール（5 ページ × 100）
 * - 30 分ごとにバックグラウンド更新
 * - description + URL に対する case-insensitive サブストリングマッチ
 * - relevance_score (0-1) で結果をソート
 * - lastUpdated は返さない（パラドックス対策: 設計B）
 *
 * API: GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
 *
 * Response format:
 *   { items: [ { resource, accepts: [{ description, maxAmountRequired, network, payTo, scheme }], ... } ],
 *     pagination: { limit, offset, total } }
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Types (matching actual CDP Discovery API) ────────────

interface AcceptOption {
  description?: string;
  maxAmountRequired?: string;
  network?: string;
  payTo?: string;
  scheme?: string;
  resource?: string;
  asset?: string;
  extra?: { name?: string; version?: string };
}

interface DiscoveryItem {
  resource: string;
  type: string;
  x402Version: number;
  accepts: AcceptOption[];
  metadata?: Record<string, unknown>;
}

interface DiscoveryResponse {
  items: DiscoveryItem[];
  pagination: { limit: number; offset: number; total: number };
}

interface BazaarEntry {
  resource: string;
  description: string;
  price: string;
  network: string;
  searchText: string; // precomputed lowercase for search
}

// ── In-memory cache ──────────────────────────────────────

let cache: BazaarEntry[] = [];
let lastRefresh = 0;
let refreshing = false;

const DISCOVERY_BASE =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const PAGES = 5;
const PER_PAGE = 100;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Convert raw maxAmountRequired (smallest unit) + asset to human-readable price.
 * USDC has 6 decimals, so 1000 = $0.001.
 */
function formatPrice(maxAmount: string | undefined, asset: string | undefined): string {
  if (!maxAmount) return "unknown";
  const n = Number(maxAmount);
  if (isNaN(n)) return maxAmount;
  // USDC (6 decimals) is the dominant asset on Base
  const decimals = 6;
  const usd = n / 10 ** decimals;
  return `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`;
}

/**
 * Fetch a single page of discovery resources.
 */
async function fetchPage(offset: number): Promise<BazaarEntry[]> {
  const url = `${DISCOVERY_BASE}?type=http&limit=${PER_PAGE}&offset=${offset}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      console.error(`[bazaar] HTTP ${res.status} for offset=${offset}`);
      return [];
    }
    const data = (await res.json()) as DiscoveryResponse;
    const items = data.items ?? [];

    return items.map((item) => {
      const accept = item.accepts?.[0];
      const description = accept?.description ?? "";
      const price = formatPrice(accept?.maxAmountRequired, accept?.asset);
      const network = accept?.network ?? "";
      return {
        resource: item.resource,
        description,
        price,
        network,
        searchText: `${item.resource} ${description}`.toLowerCase(),
      };
    });
  } catch (err) {
    console.error(`[bazaar] Fetch error offset=${offset}:`, err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Crawl all pages and rebuild the cache.
 */
async function refreshCache(): Promise<void> {
  if (refreshing) return;
  refreshing = true;

  try {
    const pages = await Promise.all(
      Array.from({ length: PAGES }, (_, i) => fetchPage(i * PER_PAGE)),
    );

    const entries: BazaarEntry[] = [];
    for (const page of pages) {
      entries.push(...page);
    }

    // Deduplicate by resource URL
    const seen = new Set<string>();
    const deduped: BazaarEntry[] = [];
    for (const e of entries) {
      if (!seen.has(e.resource)) {
        seen.add(e.resource);
        deduped.push(e);
      }
    }

    cache = deduped;
    lastRefresh = Date.now();
    console.error(`[bazaar] Cache refreshed: ${cache.length} resources`);
  } catch (err) {
    console.error("[bazaar] Refresh failed:", err);
  } finally {
    refreshing = false;
  }
}

/**
 * Ensure the cache is populated. On first call, synchronously waits.
 * After that, triggers background refresh if stale.
 */
async function ensureCache(): Promise<void> {
  if (cache.length === 0) {
    await refreshCache();
  } else if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    // Stale — trigger background refresh, return current data
    refreshCache();
  }
}

// Start background refresh interval
setInterval(() => {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    refreshCache();
  }
}, REFRESH_INTERVAL_MS);

// ── Search logic ─────────────────────────────────────────

interface SearchResult {
  resource: string;
  description: string;
  price: string;
  network: string;
  relevance_score: number;
}

function search(query: string, perPage: number): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    // No query — return top entries by default
    return cache.slice(0, perPage).map((e) => ({
      resource: e.resource,
      description: e.description,
      price: e.price,
      network: e.network,
      relevance_score: 1.0,
    }));
  }

  const scored: SearchResult[] = [];

  for (const entry of cache) {
    let matchCount = 0;
    for (const term of terms) {
      if (entry.searchText.includes(term)) {
        matchCount++;
      }
    }
    if (matchCount === 0) continue;

    // Relevance = fraction of query terms that matched
    const relevance_score = Math.round((matchCount / terms.length) * 100) / 100;

    scored.push({
      resource: entry.resource,
      description: entry.description,
      price: entry.price,
      network: entry.network,
      relevance_score,
    });
  }

  // Sort by relevance (desc), then alphabetically
  scored.sort(
    (a, b) => b.relevance_score - a.relevance_score || a.resource.localeCompare(b.resource),
  );

  return scored.slice(0, perPage);
}

// ── Execute ──────────────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE } = args;

  try {
    await ensureCache();
    const results = search(query, Math.min(per_page, 50));
    return ok(
      "bazaar",
      query,
      results,
      results.length,
      Date.now() - start,
    );
  } catch (err) {
    return fail(
      "bazaar",
      query,
      err instanceof Error ? err.message : String(err),
      Date.now() - start,
    );
  }
}

// ── MCP Registration ─────────────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("bazaar_search", {
    description:
      "Search x402 Bazaar for AI-agent APIs with micropayment access. " +
      "Queries the CDP Discovery directory of x402-enabled HTTP resources. " +
      "Returns matching APIs with price, network, and relevance score.",
    inputSchema: {
      query: z
        .string()
        .describe("Search query (matched against API URL and description)"),
      per_page: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
