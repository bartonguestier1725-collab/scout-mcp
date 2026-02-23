/**
 * lobsters_search – Lobste.rs 検索
 *
 * API: https://lobste.rs/*.json (JSON feed)
 * 認証: 不要 / コスト: 無料
 *
 * Lobste.rs に公式検索 API はない。
 * tag ベースフィード + hottest/newest フィード + クライアントサイドフィルタで対応。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface LobstersStory {
  short_id: string;
  title: string;
  url: string;
  comments_url: string;
  score: number;
  comment_count: number;
  created_at: string;
  description: string;
  submitter_user: string;
  tags: string[];
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "hot" | "newest";
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "hot" } = args;

  try {
    // Strategy: try tag feed first, then fall back to hottest/newest + filter
    const tag = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    let stories: LobstersStory[] = [];

    // Try tag-based feed
    try {
      const tagStories = await safeFetchJson<LobstersStory[]>(
        `https://lobste.rs/t/${tag}.json`,
        { timeoutMs: 8000 },
      );
      if (tagStories.length > 0) {
        stories = tagStories;
      }
    } catch {
      // Tag not found — fall through to hottest/newest
    }

    if (stories.length === 0) {
      const feedType = sort === "newest" ? "newest" : "hottest";
      stories = await safeFetchJson<LobstersStory[]>(
        `https://lobste.rs/${feedType}.json`,
      );
    }

    // Client-side keyword filter
    const keywords = query.toLowerCase().split(/\s+/);
    const filtered = stories
      .filter((s) => {
        const text = `${s.title} ${s.description} ${s.tags.join(" ")}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      })
      .slice(0, per_page);

    const items = filtered.map((s) => ({
      id: s.short_id,
      title: s.title,
      url: s.url || s.comments_url,
      lobsters_url: s.comments_url,
      score: s.score,
      comments: s.comment_count,
      author: s.submitter_user,
      tags: s.tags,
      date: s.created_at,
    }));

    return ok("lobsters", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("lobsters", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("lobsters_search", {
    description:
      "Search Lobste.rs for curated tech news and discussions. A community-driven link aggregator focused on computing, similar to Hacker News but more tightly curated. Returns title, score, comments, tags, and URLs.",
    inputSchema: {
      query: z.string().describe("Search query (used as tag + keyword filter)"),
      per_page: z.number().min(1).max(25).default(10).describe("Results per page"),
      sort: z
        .enum(["hot", "newest"])
        .default("hot")
        .describe("Sort order: hottest or newest"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
