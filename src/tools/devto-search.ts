/**
 * devto_search – Dev.to / Forem 記事検索
 *
 * API: https://developers.forem.com/api/v1
 * 認証: 不要 / コスト: 無料
 *
 * Forem 公式 API には全文検索がないため、articles エンドポイントを
 * tag フィルタ + per_page で利用する。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface DevtoArticle {
  id: number;
  title: string;
  description: string;
  url: string;
  canonical_url: string;
  published_at: string;
  positive_reactions_count: number;
  comments_count: number;
  reading_time_minutes: number;
  tag_list: string[];
  user: {
    name: string;
    username: string;
  };
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "relevance" | "latest" | "top";
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "relevance" } = args;

  try {
    // Strategy: use tag filter with first word, then client-side keyword filter
    const tag = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    const params = new URLSearchParams({
      per_page: String(Math.min(per_page * 3, 30)), // over-fetch for client filter
      tag,
    });

    // top_N for timeframe: 7 = week
    if (sort === "top") {
      params.set("top", "30");
    }

    const url = `https://dev.to/api/articles?${params}`;
    const articles = await safeFetchJson<DevtoArticle[]>(url);

    // Client-side keyword filter (tag match is loose)
    const keywords = query.toLowerCase().split(/\s+/);
    const filtered = articles
      .filter((a) => {
        const text = `${a.title} ${a.description} ${a.tag_list.join(" ")}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      })
      .slice(0, per_page);

    const items = filtered.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      url: a.url,
      author: { name: a.user.name, username: a.user.username },
      reactions: a.positive_reactions_count,
      comments: a.comments_count,
      reading_time: a.reading_time_minutes,
      tags: a.tag_list,
      date: a.published_at,
    }));

    return ok("devto", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("devto", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("devto_search", {
    description:
      "Search Dev.to (Forem) for technical articles and blog posts. Returns title, description, reactions, comments, reading time, and tags. Great for tutorials, how-tos, and developer insights.",
    inputSchema: {
      query: z.string().describe("Search query (used as tag filter + keyword match)"),
      per_page: z.number().min(1).max(30).default(10).describe("Results per page"),
      sort: z
        .enum(["relevance", "latest", "top"])
        .default("relevance")
        .describe("Sort order"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
