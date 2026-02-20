/**
 * hackernews_search – Hacker News 検索 (Algolia API)
 *
 * API: https://hn.algolia.com/api
 * 認証: 不要 / コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Algolia response types ────────────────────────

interface HnHit {
  objectID: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
  _tags?: string[];
}

interface HnResponse {
  hits: HnHit[];
  nbHits: number;
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  sort?: "relevance" | "date";
  per_page?: number;
  tag?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, sort = "relevance", per_page = config.DEFAULT_PER_PAGE, tag } = args;

  try {
    const endpoint = sort === "date" ? "search_by_date" : "search";
    const params = new URLSearchParams({
      query,
      hitsPerPage: String(Math.min(per_page, 50)),
    });
    if (tag) params.set("tags", tag);

    const url = `https://hn.algolia.com/api/v1/${endpoint}?${params}`;
    const res = await safeFetchJson<HnResponse>(url);

    const items = res.hits.map((h) => ({
      id: h.objectID,
      title: h.title || h.story_title || "(comment)",
      url: h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      author: h.author,
      points: h.points,
      comments: h.num_comments,
      date: h.created_at,
      type: h._tags?.[0] ?? "unknown",
    }));

    return ok("hackernews", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("hackernews", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("hackernews_search", {
    description:
      "Search Hacker News (stories, comments, polls) via Algolia. Good for developer sentiment, trending tech topics, and community discussions.",
    inputSchema: {
      query: z.string().describe("Search query"),
      sort: z.enum(["relevance", "date"]).default("relevance").describe("Sort order"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
      tag: z
        .string()
        .optional()
        .describe("Filter by tag: story, comment, poll, show_hn, ask_hn"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
