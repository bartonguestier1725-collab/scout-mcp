/**
 * npm_search – npm Registry 検索
 *
 * API: https://registry.npmjs.org/-/v1/search
 * 認証: 不要 / コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── npm response types ────────────────────────────

interface NpmPackage {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date: string;
  links: { npm?: string; homepage?: string; repository?: string };
  publisher?: { username: string };
}

interface NpmSearchResult {
  package: NpmPackage;
  score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
  searchScore: number;
}

interface NpmSearchResponse {
  objects: NpmSearchResult[];
  total: number;
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE } = args;

  try {
    const params = new URLSearchParams({
      text: query,
      size: String(Math.min(per_page, 50)),
    });
    const url = `https://registry.npmjs.org/-/v1/search?${params}`;
    const res = await safeFetchJson<NpmSearchResponse>(url);

    const items = res.objects.map((o) => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description ?? "",
      keywords: o.package.keywords ?? [],
      npm_url: o.package.links.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
      homepage: o.package.links.homepage ?? null,
      repository: o.package.links.repository ?? null,
      publisher: o.package.publisher?.username ?? null,
      updated: o.package.date,
      score: {
        final: Math.round(o.score.final * 100) / 100,
        quality: Math.round(o.score.detail.quality * 100) / 100,
        popularity: Math.round(o.score.detail.popularity * 100) / 100,
        maintenance: Math.round(o.score.detail.maintenance * 100) / 100,
      },
    }));

    return ok("npm", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("npm", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("npm_search", {
    description:
      "Search the npm package registry. Returns package name, version, description, scores (quality/popularity/maintenance), and links.",
    inputSchema: {
      query: z.string().describe("Search query (package name, keywords, or description)"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
