/**
 * x_search – X (Twitter) 検索 via xAI Grok API
 *
 * xAI の Responses API (grok-4-1-fast-non-reasoning) を使い、
 * web_search ツールで X の投稿を検索する。
 *
 * 認証: XAI_API_KEY 必須
 * コスト: ~$0.003/回 (usage.cost_in_usd_ticks で正確に取得)
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

interface XaiResponse {
  id: string;
  output: XaiOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_in_usd_ticks?: number;
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

    // Cost from xAI usage (cost_in_usd_ticks = USD * 10^9)
    const usage = res.usage;
    const cost = usage
      ? {
          usd: usage.cost_in_usd_ticks
            ? usage.cost_in_usd_ticks / 1_000_000_000
            : (usage.input_tokens * 0.3 + usage.output_tokens * 0.5) / 1_000_000,
          breakdown: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
          },
        }
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
      "Search X (Twitter) for posts, discussions, and trends using xAI's Grok API with web search. Requires XAI_API_KEY. Cost: ~$0.003/call.",
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
