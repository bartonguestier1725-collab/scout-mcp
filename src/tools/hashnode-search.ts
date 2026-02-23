/**
 * hashnode_search – Hashnode 記事検索 (GraphQL API)
 *
 * API: https://gql.hashnode.com/
 * 認証: 不要 / コスト: 無料
 *
 * Hashnode の公開 GraphQL API を使って tag ベースで記事を検索。
 * 全文検索がないため tag スラッグ + クライアントサイドフィルタで対応。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── GraphQL query ────────────────────────────────

const FEED_QUERY = `
query Feed($first: Int!, $filter: FeedFilter!) {
  feed(first: $first, filter: $filter) {
    edges {
      node {
        id
        title
        brief
        url
        publishedAt
        reactionCount
        responseCount
        author {
          name
          username
        }
        tags {
          name
          slug
        }
      }
    }
  }
}`;

const TAG_FEED_QUERY = `
query TagFeed($slug: String!, $first: Int!) {
  tag(slug: $slug) {
    posts(first: $first, filter: { sortBy: popular }) {
      edges {
        node {
          id
          title
          brief
          url
          publishedAt
          reactionCount
          responseCount
          author {
            name
            username
          }
          tags {
            name
            slug
          }
        }
      }
    }
  }
}`;

// ── Types ────────────────────────────────────────

interface HashnodePost {
  id: string;
  title: string;
  brief: string;
  url: string;
  publishedAt: string;
  reactionCount: number;
  responseCount: number;
  readTimeInMinutes?: number;
  author: { name: string; username: string };
  tags: Array<{ name: string; slug: string }>;
}

interface GqlResponse {
  errors?: Array<{ message: string }>;
  data?: {
    feed?: { edges: Array<{ node: HashnodePost }> };
    tag?: { posts?: { edges: Array<{ node: HashnodePost }> } };
  };
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE } = args;

  try {
    const slug = query.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const fetchSize = Math.min(per_page * 3, 20);

    // Try tag-based query first
    const tagRes = await safeFetchJson<GqlResponse>("https://gql.hashnode.com/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: TAG_FEED_QUERY,
        variables: { slug, first: fetchSize },
      }),
    });

    let posts: HashnodePost[] = [];

    if (!tagRes.errors && tagRes.data?.tag?.posts?.edges?.length) {
      posts = tagRes.data.tag.posts.edges.map((e) => e.node);
    } else {
      // Fallback: use feed with RELEVANT filter
      const feedRes = await safeFetchJson<GqlResponse>("https://gql.hashnode.com/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: FEED_QUERY,
          variables: { first: fetchSize, filter: { type: "RELEVANT" } },
        }),
      });

      if (feedRes.errors?.length) {
        const msg = feedRes.errors.map((e) => e.message).join("; ");
        return fail("hashnode", query, `GraphQL error: ${msg}`, Date.now() - start);
      }

      posts = (feedRes.data?.feed?.edges || []).map((e) => e.node);

      // Client-side keyword filter
      const keywords = query.toLowerCase().split(/\s+/);
      posts = posts.filter((p) => {
        const text = `${p.title} ${p.brief} ${p.tags.map((t) => t.name).join(" ")}`.toLowerCase();
        return keywords.some((kw) => text.includes(kw));
      });
    }

    const items = posts.slice(0, per_page).map((p) => ({
      id: p.id,
      title: p.title,
      brief: p.brief,
      url: p.url,
      author: { name: p.author.name, username: p.author.username },
      reactions: p.reactionCount,
      responses: p.responseCount,
      reading_time: p.readTimeInMinutes ?? null,
      tags: p.tags.map((t) => t.name),
      date: p.publishedAt,
    }));

    return ok("hashnode", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("hashnode", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("hashnode_search", {
    description:
      "Search Hashnode for technical blog posts. Uses tag-based lookup with keyword filtering. Returns title, brief, reactions, reading time, and author info. Good for in-depth technical articles.",
    inputSchema: {
      query: z.string().describe("Search query (used as tag slug + keyword filter)"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
