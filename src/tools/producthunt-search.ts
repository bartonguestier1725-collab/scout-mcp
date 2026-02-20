/**
 * producthunt_search – Product Hunt 検索 (GraphQL API)
 *
 * API: https://api.producthunt.com/v2/api/graphql
 * 認証: PH_CLIENT_ID + PH_CLIENT_SECRET → OAuth token
 * コスト: 無料
 *
 * 注意: PH GraphQL API の posts クエリには search 引数がない。
 * topic スラッグでのフィルタ + order (VOTES/NEWEST) のみ。
 * query を topic として使い、該当なければ最新の投稿を返す。
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
    expiresAt: Date.now() + (res.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

// ── GraphQL queries ───────────────────────────────

const POSTS_BY_TOPIC_QUERY = `
query PostsByTopic($topic: String!, $first: Int!, $order: PostsOrder!) {
  posts(topic: $topic, first: $first, order: $order) {
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

const LATEST_POSTS_QUERY = `
query LatestPosts($first: Int!, $order: PostsOrder!) {
  posts(first: $first, order: $order) {
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

// ── Helpers ───────────────────────────────────────

interface PostNode {
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
}

interface GqlResponse {
  errors?: Array<{ message: string }>;
  data?: {
    posts?: {
      edges: Array<{ node: PostNode }>;
    };
  };
}

function mapPosts(edges: Array<{ node: PostNode }>, query: string) {
  const q = query.toLowerCase();
  return edges
    .map((e) => {
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
    })
    .filter((p) => {
      // Client-side keyword filter when not using topic-based query
      const text = `${p.name} ${p.tagline} ${p.description}`.toLowerCase();
      return text.includes(q);
    });
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  order?: "VOTES" | "NEWEST";
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, order = "VOTES", per_page = config.DEFAULT_PER_PAGE } = args;

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
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    // Strategy: try topic-based first, then fall back to latest + client filter
    // Fetch more than needed since client-side filter may reduce results
    const fetchSize = Math.min(per_page * 3, 20);

    // Try topic-based query first
    const topicSlug = query.toLowerCase().replace(/\s+/g, "-");
    const topicRes = await safeFetchJson<GqlResponse>(
      "https://api.producthunt.com/v2/api/graphql",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: POSTS_BY_TOPIC_QUERY,
          variables: { topic: topicSlug, first: fetchSize, order },
        }),
      },
    );

    // If topic query succeeded, use those results
    if (!topicRes.errors && topicRes.data?.posts?.edges?.length) {
      const items = topicRes.data.posts.edges.map((e) => {
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
      }).slice(0, per_page);

      return ok("producthunt", query, items, items.length, Date.now() - start);
    }

    // Fallback: fetch latest posts and filter client-side by keyword
    const latestRes = await safeFetchJson<GqlResponse>(
      "https://api.producthunt.com/v2/api/graphql",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: LATEST_POSTS_QUERY,
          variables: { first: fetchSize, order },
        }),
      },
    );

    if (latestRes.errors?.length) {
      const msg = latestRes.errors.map((e) => e.message).join("; ");
      return fail("producthunt", query, `GraphQL error: ${msg}`, Date.now() - start);
    }

    if (!latestRes.data?.posts?.edges) {
      return fail("producthunt", query, "Unexpected response: missing data.posts.edges", Date.now() - start);
    }

    const items = mapPosts(latestRes.data.posts.edges, query).slice(0, per_page);
    return ok("producthunt", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("producthunt", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("producthunt_search", {
    description:
      "Search Product Hunt for products and launches. Tries topic-based lookup first, then falls back to keyword filtering on recent posts. Returns votes, comments, topics, makers, and descriptions. Requires PH_CLIENT_ID/SECRET.",
    inputSchema: {
      query: z.string().describe("Search query (topic slug or keywords)"),
      order: z.enum(["VOTES", "NEWEST"]).default("VOTES").describe("Sort order"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
