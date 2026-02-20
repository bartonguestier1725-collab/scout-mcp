/**
 * x_search – X (Twitter) 検索 via xAI Grok API
 *
 * xAI の Responses API (grok-4.1-fast) を使い、
 * web_search ツールで X の投稿を検索する。
 *
 * 認証: XAI_API_KEY 必須
 * コスト: ~$0.005/回 (input $0.30/M + output $0.50/M tokens)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── xAI response types ───────────────────────────

interface XaiResponseItem {
  type: string;
  id?: string;
  text?: string;
  // web_search result items
  results?: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  // output_text
  content?: Array<{ type: string; text: string }>;
}

interface XaiResponse {
  id: string;
  output: XaiResponseItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
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
    const systemPrompt = `You are a search assistant. Search X (Twitter) for the query and return results as JSON array.
Each item: {"author": "...", "text": "...", "url": "...", "date": "...", "engagement": "..."}
Return up to ${per_page} results. Only return the JSON array, no other text.`;

    const userPrompt = `Search X/Twitter for: "${query}" (last ${recency}). Return the ${per_page} most relevant posts as JSON.`;

    const body = {
      model: "grok-4.1-fast",
      tools: [{ type: "web_search", search_parameters: { recency_filter: recency } }],
      input: [
        { role: "system", content: systemPrompt },
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
      timeoutMs: 30_000, // LLM calls need more time
    });

    // Extract web search results and output text
    const webResults: Array<{ title: string; url: string; snippet: string }> = [];
    let outputText = "";

    for (const item of res.output) {
      if (item.type === "web_search_call") {
        // The search call itself
      } else if (item.type === "web_search_result" && item.results) {
        webResults.push(...item.results);
      } else if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text") outputText += c.text;
        }
      }
    }

    // Try to parse the LLM's structured output, fall back to web search results
    let posts: unknown[] = [];
    try {
      const jsonMatch = outputText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        posts = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // JSON parse failed — will fall through to webResults fallback below
    }

    // Fallback: if LLM didn't produce usable JSON, use raw web search results
    if (posts.length === 0 && webResults.length > 0) {
      posts = webResults.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }));
    }

    // Cost estimate based on token usage
    const usage = res.usage;
    const cost = usage
      ? {
          usd: (usage.input_tokens * 0.3 + usage.output_tokens * 0.5) / 1_000_000,
          breakdown: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
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
      "Search X (Twitter) for posts, discussions, and trends using xAI's Grok API with web search. Requires XAI_API_KEY. Cost: ~$0.005/call.",
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
