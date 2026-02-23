/**
 * qiita_search – Qiita 記事検索（公式 API v2）
 *
 * API: https://qiita.com/api/v2/items
 * 認証: 不要（60 req/h）/ トークンありで 1000 req/h
 * コスト: 無料
 *
 * 日本最大の技術記事プラットフォーム。Zenn と合わせて日本語技術記事を網羅。
 * MCP 限定（個人利用）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface QiitaItem {
  id: string;
  title: string;
  body: string;
  url: string;
  created_at: string;
  updated_at: string;
  likes_count: number;
  stocks_count: number;
  comments_count: number;
  page_views_count: number | null;
  tags: Array<{ name: string }>;
  user: {
    id: string;
    name: string;
    permanent_id: number;
    profile_image_url: string;
  };
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE } = args;

  try {
    const params = new URLSearchParams({
      query,
      per_page: String(Math.min(per_page, 20)),
      page: "1",
    });

    const url = `https://qiita.com/api/v2/items?${params}`;
    const headers: Record<string, string> = {};

    // Optional auth token for higher rate limit
    const qiitaToken = process.env.QIITA_TOKEN;
    if (qiitaToken) {
      headers["Authorization"] = `Bearer ${qiitaToken}`;
    }

    const articles = await safeFetchJson<QiitaItem[]>(url, { headers });

    const items = articles.slice(0, per_page).map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      author: { id: a.user.id, name: a.user.name || a.user.id },
      likes: a.likes_count,
      stocks: a.stocks_count,
      comments: a.comments_count,
      tags: a.tags.map((t) => t.name),
      date: a.created_at,
    }));

    return ok("qiita", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("qiita", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("qiita_search", {
    description:
      "Search Qiita (Japan's largest developer article platform) for technical articles. Returns title, likes, stocks, comments, tags, and author info. Best for Japanese tech content. Complements Zenn search.",
    inputSchema: {
      query: z.string().describe("Search query (supports Japanese and tag:xxx syntax)"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
