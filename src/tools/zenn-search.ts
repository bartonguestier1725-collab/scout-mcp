/**
 * zenn_search – Zenn 記事検索（非公式 API）
 *
 * API: https://zenn.dev/api/articles (非公式・ドキュメントなし)
 * 認証: 不要 / コスト: 無料
 *
 * 非公式 API のため予告なく仕様変更・廃止の可能性あり。
 * MCP 限定（x402 有料エンドポイントには出さない）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface ZennArticle {
  id: number;
  title: string;
  slug: string;
  published_at: string;
  body_letters_count: number;
  liked_count: number;
  comments_count: number;
  article_type: string; // "tech" | "idea"
  emoji: string;
  path: string;
  user: {
    id: number;
    username: string;
    name: string;
    avatar_small_url: string;
  };
  topics?: Array<{
    id: number;
    name: string;
    display_name: string;
    image_url: string;
  }>;
}

interface ZennResponse {
  articles: ZennArticle[];
  next_page: number | null;
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  article_type?: "tech" | "idea";
  order?: "latest" | "daily" | "weekly" | "monthly" | "alltime";
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, article_type, order = "daily" } = args;

  try {
    // Zenn API supports topicname for tag-based search
    const topicSlug = query.toLowerCase().replace(/[^a-z0-9]/g, "");

    const params = new URLSearchParams({
      count: String(Math.min(per_page * 3, 48)), // max 48 per page
      order,
    });

    if (topicSlug) {
      params.set("topicname", topicSlug);
    }
    if (article_type) {
      params.set("article_type", article_type);
    }

    const url = `https://zenn.dev/api/articles?${params}`;
    const res = await safeFetchJson<ZennResponse>(url);

    if (!res.articles || !Array.isArray(res.articles)) {
      return fail("zenn", query, "Unexpected API response format", Date.now() - start);
    }

    // Client-side keyword filter
    const keywords = query.toLowerCase().split(/\s+/);
    const filtered = res.articles
      .filter((a) => {
        const topicNames = (a.topics || []).map((t) => t.display_name).join(" ");
        const text = `${a.title} ${topicNames} ${a.user.username}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      })
      .slice(0, per_page);

    const items = filtered.map((a) => ({
      id: a.id,
      title: a.title,
      emoji: a.emoji,
      url: `https://zenn.dev${a.path}`,
      author: { name: a.user.name, username: a.user.username },
      likes: a.liked_count,
      comments: a.comments_count,
      type: a.article_type,
      body_length: a.body_letters_count,
      topics: (a.topics || []).map((t) => t.display_name),
      date: a.published_at,
    }));

    return ok("zenn", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("zenn", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("zenn_search", {
    description:
      "Search Zenn (Japanese tech blog platform) for technical articles. Uses topic-based lookup with keyword filtering. Returns title, likes, comments, topics, and author info. Best for Japanese tech content. Note: uses unofficial API.",
    inputSchema: {
      query: z.string().describe("Search query (used as topic slug + keyword filter)"),
      per_page: z.number().min(1).max(48).default(10).describe("Results per page"),
      article_type: z
        .enum(["tech", "idea"])
        .optional()
        .describe("Filter by article type: tech (technical) or idea (opinion/essay)"),
      order: z
        .enum(["latest", "daily", "weekly", "monthly", "alltime"])
        .default("daily")
        .describe("Sort order by time period popularity"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
