/**
 * reddit_search – Reddit 検索 (OAuth2 client credentials)
 *
 * API: https://oauth.reddit.com/search
 * 認証: OAuth2 (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET)
 * コスト: 無料（個人・非商用利用のみ）
 * レート制限: 100 req/min
 *
 * 注意: Reddit API は商用利用に $12,000+/年が必要。
 * このツールは MCP モード（自己使用）でのみ有効。x402 HTTP では公開しない。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Token cache ──────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const auth = Buffer.from(
    `${config.REDDIT_CLIENT_ID}:${config.REDDIT_CLIENT_SECRET}`,
  ).toString("base64");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "scout-mcp/1.0 (by u/scout-mcp-bot)",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(`Reddit auth failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

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
    children: Array<{ data: RedditPost }>;
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
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "relevance", time = "all", subreddit } = args;

  if (!config.REDDIT_CLIENT_ID || !config.REDDIT_CLIENT_SECRET) {
    return fail(
      "reddit",
      query,
      "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET not configured",
      Date.now() - start,
    );
  }

  try {
    const token = await getAccessToken();

    const params = new URLSearchParams({
      q: query,
      sort,
      t: time,
      limit: String(Math.min(per_page, 100)),
      type: "link", // posts only (not comments or subreddits)
    });

    if (subreddit) {
      params.set("restrict_sr", "true");
    }

    const baseUrl = subreddit
      ? `https://oauth.reddit.com/r/${subreddit}/search`
      : "https://oauth.reddit.com/search";

    const res = await fetch(`${baseUrl}?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "scout-mcp/1.0 (by u/scout-mcp-bot)",
      },
    });

    if (!res.ok) {
      throw new Error(`Reddit API error: HTTP ${res.status}`);
    }

    const data = (await res.json()) as RedditSearchResponse;

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
      "Search Reddit for posts and discussions. Returns title, score, comments, subreddit, and content preview. Great for community sentiment, user experiences, and real-world feedback. Requires REDDIT_CLIENT_ID/SECRET.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(100).default(10).describe("Results per page"),
      sort: z
        .enum(["relevance", "hot", "new", "top", "comments"])
        .default("relevance")
        .describe("Sort order"),
      time: z
        .enum(["hour", "day", "week", "month", "year", "all"])
        .default("all")
        .describe("Time filter (for 'top' and 'relevance' sorts)"),
      subreddit: z
        .string()
        .optional()
        .describe("Restrict search to a specific subreddit"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
