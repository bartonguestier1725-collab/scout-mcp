/**
 * reddit_search – Reddit 検索（公開 .json フィード）
 *
 * API: https://www.reddit.com/search.json
 * 認証: 不要（User-Agent 必須）
 * レート制限: 10 req/min（IP ベース）
 * コスト: 無料
 *
 * Reddit の公開 JSON エンドポイントを使用。OAuth 不要。
 * 商用再配布は不可のため x402 HTTP には出さない（MCP 限定）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  subreddit: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
  is_self: boolean;
  link_flair_text: string | null;
}

interface RedditSearchResponse {
  data: {
    children: Array<{ kind: string; data: RedditPost }>;
  };
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "relevance" | "hot" | "new" | "top" | "comments";
  time?: "hour" | "day" | "week" | "month" | "year" | "all";
  subreddit?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "relevance", time = "week", subreddit } = args;

  try {
    const params = new URLSearchParams({
      q: query,
      sort,
      t: time,
      limit: String(Math.min(per_page, 25)), // keep modest for public endpoint
      type: "link",
      raw_json: "1", // avoid HTML entity encoding
    });

    if (subreddit) {
      params.set("restrict_sr", "true");
    }

    const baseUrl = subreddit
      ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json`
      : "https://www.reddit.com/search.json";

    const res = await fetch(`${baseUrl}?${params}`, {
      headers: {
        "User-Agent": "scout-mcp/1.0 (personal research tool)",
      },
    });

    if (res.status === 429) {
      return fail("reddit", query, "Rate limited (10 req/min). Try again shortly.", Date.now() - start);
    }

    if (!res.ok) {
      throw new Error(`Reddit HTTP ${res.status}`);
    }

    const data = (await res.json()) as RedditSearchResponse;

    if (!data?.data?.children) {
      return fail("reddit", query, "Unexpected response format", Date.now() - start);
    }

    const items = data.data.children.map((child) => {
      const p = child.data;
      return {
        id: p.id,
        title: p.title,
        selftext: p.selftext?.slice(0, 300) || "",
        url: p.is_self ? `https://reddit.com${p.permalink}` : p.url,
        reddit_url: `https://reddit.com${p.permalink}`,
        subreddit: p.subreddit,
        author: p.author,
        score: p.score,
        comments: p.num_comments,
        flair: p.link_flair_text,
        date: new Date(p.created_utc * 1000).toISOString(),
      };
    });

    return ok("reddit", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("reddit", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("reddit_search", {
    description:
      "Search Reddit for posts and discussions using public JSON feeds (no API key required). Returns title, score, comments, subreddit, and content preview. Great for community sentiment, user experiences, and real-world feedback. Rate limit: 10 req/min.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(25).default(10).describe("Results per page (max 25)"),
      sort: z
        .enum(["relevance", "hot", "new", "top", "comments"])
        .default("relevance")
        .describe("Sort order"),
      time: z
        .enum(["hour", "day", "week", "month", "year", "all"])
        .default("week")
        .describe("Time filter"),
      subreddit: z
        .string()
        .optional()
        .describe("Restrict search to a specific subreddit (e.g. 'programming')"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
