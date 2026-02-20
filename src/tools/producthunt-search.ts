/**
 * producthunt_search – Product Hunt 検索 (GraphQL API)
 *
 * API: https://api.producthunt.com/v2/api/graphql
 * 認証: PH_CLIENT_ID + PH_CLIENT_SECRET → OAuth token
 * コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Token cache ───────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await safeFetchJson<{ access_token: string; expires_in: number }>(
    "https://api.producthunt.com/v2/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.PH_CLIENT_ID,
        client_secret: config.PH_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    },
  );

  cachedToken = {
    token: res.access_token,
    expiresAt: Date.now() + (res.expires_in - 60) * 1000, // refresh 60s early
  };
  return cachedToken.token;
}

// ── GraphQL query ─────────────────────────────────

const SEARCH_QUERY = `
query SearchPosts($query: String!, $first: Int!) {
  posts(search: $query, first: $first, order: VOTES) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        votesCount
        commentsCount
        createdAt
        website
        topics {
          edges {
            node {
              name
            }
          }
        }
        makers {
          name
          username
        }
        thumbnail {
          url
        }
      }
    }
  }
}`;

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE } = args;

  if (!config.PH_CLIENT_ID || !config.PH_CLIENT_SECRET) {
    return fail(
      "producthunt",
      query,
      "PH_CLIENT_ID and PH_CLIENT_SECRET not configured",
      Date.now() - start,
    );
  }

  try {
    const token = await getAccessToken();

    const res = await safeFetchJson<{
      errors?: Array<{ message: string }>;
      data?: {
        posts?: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              tagline: string;
              description: string;
              url: string;
              votesCount: number;
              commentsCount: number;
              createdAt: string;
              website: string;
              topics: { edges: Array<{ node: { name: string } }> };
              makers: Array<{ name: string; username: string }>;
              thumbnail: { url: string } | null;
            };
          }>;
        };
      };
    }>("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { query, first: Math.min(per_page, 20) },
      }),
    });

    // GraphQL returns HTTP 200 even on errors — check explicitly
    if (res.errors?.length) {
      const msg = res.errors.map((e) => e.message).join("; ");
      return fail("producthunt", query, `GraphQL error: ${msg}`, Date.now() - start);
    }

    if (!res.data?.posts?.edges) {
      return fail("producthunt", query, "Unexpected response: missing data.posts.edges", Date.now() - start);
    }

    const items = res.data.posts.edges.map((e) => {
      const p = e.node;
      return {
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        description: p.description,
        ph_url: p.url,
        website: p.website,
        votes: p.votesCount,
        comments: p.commentsCount,
        date: p.createdAt,
        topics: p.topics.edges.map((t) => t.node.name),
        makers: p.makers.map((m) => ({ name: m.name, username: m.username })),
        thumbnail: p.thumbnail?.url ?? null,
      };
    });

    return ok("producthunt", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("producthunt", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("producthunt_search", {
    description:
      "Search Product Hunt for products and launches. Returns votes, comments, topics, makers, and descriptions. Requires PH_CLIENT_ID/SECRET.",
    inputSchema: {
      query: z.string().describe("Search query (product name or category)"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
