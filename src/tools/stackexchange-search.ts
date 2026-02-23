/**
 * stackexchange_search – StackExchange / Stack Overflow 検索
 *
 * API: https://api.stackexchange.com/2.3/
 * 認証: 不要（key ありで 10,000 req/day、なしで 300 req/day）
 * コスト: 無料
 *
 * レスポンスは常に gzip 圧縮。Node.js fetch が自動展開する。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface SeQuestion {
  question_id: number;
  title: string;
  link: string;
  score: number;
  answer_count: number;
  view_count: number;
  is_answered: boolean;
  creation_date: number; // Unix timestamp
  tags: string[];
  owner: {
    display_name: string;
    reputation?: number;
    link?: string;
  };
}

interface SeResponse {
  items: SeQuestion[];
  has_more: boolean;
  quota_remaining: number;
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "relevance" | "votes" | "activity" | "creation";
  site?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const {
    query,
    per_page = config.DEFAULT_PER_PAGE,
    sort = "relevance",
    site = "stackoverflow",
  } = args;

  try {
    const params = new URLSearchParams({
      order: "desc",
      sort,
      q: query,
      site,
      pagesize: String(Math.min(per_page, 50)),
      filter: "withbody", // include body excerpt
    });

    if (config.SE_API_KEY) {
      params.set("key", config.SE_API_KEY);
    }

    const url = `https://api.stackexchange.com/2.3/search/advanced?${params}`;
    const res = await safeFetchJson<SeResponse>(url);

    const items = res.items.map((q) => ({
      id: q.question_id,
      title: q.title,
      url: q.link,
      score: q.score,
      answers: q.answer_count,
      views: q.view_count,
      is_answered: q.is_answered,
      tags: q.tags,
      author: q.owner.display_name,
      author_reputation: q.owner.reputation,
      date: new Date(q.creation_date * 1000).toISOString(),
    }));

    return ok("stackexchange", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("stackexchange", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("stackexchange_search", {
    description:
      "Search Stack Overflow and other StackExchange sites for Q&A. Returns questions with score, answer count, views, tags, and accepted answer status. Great for technical problem-solving and community knowledge.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
      sort: z
        .enum(["relevance", "votes", "activity", "creation"])
        .default("relevance")
        .describe("Sort order"),
      site: z
        .string()
        .default("stackoverflow")
        .describe("StackExchange site (e.g. stackoverflow, serverfault, superuser)"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
