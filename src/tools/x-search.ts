/**
 * x_search – X (Twitter) 検索 via xAI Grok API
 *
 * xAI の Responses API (grok-4-1-fast-non-reasoning) を使い、
 * web_search ツールで X の投稿を検索する。
 *
 * 認証: XAI_API_KEY 必須
 * コスト: ~$0.05/回 (web_search $0.005/call × 平均8-9回 + トークンコスト)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── xAI response types ───────────────────────────

interface XaiOutputItem {
  type: string;
  id?: string;
  status?: string;
  action?: { type: string; query?: string; url?: string };
  content?: Array<{
    type: string;
    text: string;
    annotations?: Array<{ type: string; url: string; title?: string }>;
  }>;
}

interface XaiUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_in_usd_ticks?: number;
  server_side_tool_usage_details?: {
    web_search_calls?: number;
  };
}

interface XaiResponse {
  id: string;
  output: XaiOutputItem[];
  usage?: XaiUsage;
  /** Top-level billable tool usage (xAI docs: primary source for web_search counts) */
  server_side_tool_usage?: {
    web_search_calls?: number;
  };
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  recency?: "day" | "week" | "month";
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, recency = "week", per_page = 10 } = args;

  if (!config.XAI_API_KEY) {
    return fail("x", query, "XAI_API_KEY not configured", Date.now() - start);
  }

  try {
    const userPrompt = `Use web search to find recent posts on X (twitter.com/x.com) about: "${query}"
Return ${per_page} results as a JSON array with fields: author, text, url, date.`;

    const body = {
      model: "grok-4-1-fast-non-reasoning",
      tool_choice: "required",
      tools: [{ type: "web_search" }],
      input: [
        { role: "user", content: userPrompt },
      ],
    };

    const res = await safeFetchJson<XaiResponse>("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.XAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      timeoutMs: 45_000,
    });

    // Extract output text from message items
    let outputText = "";
    const citedUrls: Array<{ url: string; title?: string }> = [];

    for (const item of res.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text") {
            outputText += c.text;
            if (c.annotations) {
              for (const a of c.annotations) {
                if (a.type === "url_citation") {
                  citedUrls.push({ url: a.url, title: a.title });
                }
              }
            }
          }
        }
      }
    }

    // Parse LLM's JSON output
    let posts: unknown[] = [];
    try {
      const jsonMatch = outputText.match(/\[[\s\S]*?\](?=\s*(\[|$))/);
      if (jsonMatch) {
        posts = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // JSON parse failed
    }

    // Fallback: if no parseable JSON, build results from URL citations
    if (posts.length === 0 && citedUrls.length > 0) {
      posts = citedUrls.map((c) => ({
        url: c.url,
        title: c.title ?? "",
        source: "url_citation",
      }));
    }

    // Cost calculation — web_search $0.005/call + token cost
    // NOTE: cost_in_usd_ticks is ~10x inflated vs dashboard billing (2026-02-22 verified).
    //       Use component-based calculation instead.
    const WEB_SEARCH_UNIT_COST = 0.005; // xAI: $5/1000 web search calls
    const usage = res.usage;
    const cost = usage
      ? (() => {
          const tokenCost = (usage.input_tokens * 0.3 + usage.output_tokens * 0.5) / 1_000_000;
          // Priority for web_search call count:
          // 1st: response.server_side_tool_usage (xAI docs: billable successful count)
          // 2nd: usage.server_side_tool_usage_details (nested in usage object)
          // 3rd: count output items with type "web_search_call" (heuristic)
          // null = all detection failed → use XAI_COST_PER_CALL fallback
          const wsFromTop = res.server_side_tool_usage?.web_search_calls;
          const wsFromUsage = usage.server_side_tool_usage_details?.web_search_calls;
          const wsFromOutput = (wsFromTop == null && wsFromUsage == null)
            ? res.output.filter(i => i.type.includes("web_search")).length || null
            : undefined;
          // Resolve: first non-null/undefined value, or null if all sources failed
          const wsResolved = wsFromTop ?? wsFromUsage ?? wsFromOutput;
          // null/undefined = all detection failed → fallback to config.XAI_COST_PER_CALL
          // 0 = zero searches actually executed → search cost is $0 (only token cost)
          const usd = wsResolved == null
            ? config.XAI_COST_PER_CALL
            : wsResolved * WEB_SEARCH_UNIT_COST + tokenCost;
          return {
            usd,
            breakdown: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              total_tokens: usage.total_tokens,
              web_search_calls: wsResolved ?? -1, // -1 signals detection failure
            },
          };
        })()
      : undefined;

    return ok("x", query, posts, Array.isArray(posts) ? posts.length : 0, Date.now() - start, cost);
  } catch (err) {
    return fail("x", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("x_search", {
    description:
      "Search X (Twitter) for posts, discussions, and trends using xAI's Grok API with web search. Requires XAI_API_KEY. Cost: ~$0.05/call (web_search $0.005 × 8-9 calls + tokens).",
    inputSchema: {
      query: z.string().describe("Search query for X/Twitter"),
      recency: z
        .enum(["day", "week", "month"])
        .default("week")
        .describe("Time filter for results"),
      per_page: z.number().min(1).max(20).default(10).describe("Number of results to return"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
