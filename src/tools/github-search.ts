/**
 * github_search – GitHub リポジトリ検索
 *
 * API: https://docs.github.com/en/rest/search
 * 認証: GITHUB_TOKEN 推奨（レート制限 10→30 req/min）
 * コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── GitHub response types ─────────────────────────

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  topics: string[];
  created_at: string;
  updated_at: string;
  license: { spdx_id: string } | null;
}

interface GhSearchResponse {
  total_count: number;
  items: GhRepo[];
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  sort?: "stars" | "forks" | "updated" | "best-match";
  per_page?: number;
  language?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, sort = "best-match", per_page = config.DEFAULT_PER_PAGE, language } = args;

  try {
    let q = query;
    if (language) q += ` language:${language}`;

    const params = new URLSearchParams({
      q,
      per_page: String(Math.min(per_page, 50)),
    });
    if (sort !== "best-match") params.set("sort", sort);

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
    }

    const url = `https://api.github.com/search/repositories?${params}`;
    const res = await safeFetchJson<GhSearchResponse>(url, { headers });

    const items = res.items.map((r) => ({
      name: r.full_name,
      url: r.html_url,
      description: r.description,
      stars: r.stargazers_count,
      forks: r.forks_count,
      open_issues: r.open_issues_count,
      language: r.language,
      topics: r.topics,
      license: r.license?.spdx_id ?? null,
      created: r.created_at,
      updated: r.updated_at,
    }));

    return ok("github", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("github", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("github_search", {
    description:
      "Search GitHub repositories by keyword, topic, or description. Returns stars, forks, language, topics, and license info.",
    inputSchema: {
      query: z.string().describe("Search query (supports GitHub search qualifiers like 'topic:mcp')"),
      sort: z
        .enum(["stars", "forks", "updated", "best-match"])
        .default("best-match")
        .describe("Sort order"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
      language: z.string().optional().describe("Filter by programming language (e.g. 'typescript')"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
