/**
 * lemmy_search – Lemmy 検索（公式 API v3）
 *
 * API: https://lemmy.world/api/v3/search
 * 認証: 不要
 * コスト: 無料
 *
 * Fediverse の Reddit 代替。Reddit API 閉鎖後にテック系コミュニティが移住中。
 * MCP 限定。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface LemmyPost {
  post: {
    id: number;
    name: string;
    body: string | null;
    url: string | null;
    ap_id: string;
    published: string;
  };
  creator: {
    name: string;
    actor_id: string;
  };
  community: {
    name: string;
    title: string;
    actor_id: string;
  };
  counts: {
    score: number;
    comments: number;
    upvotes: number;
    downvotes: number;
  };
}

interface LemmySearchResponse {
  posts: LemmyPost[];
}

// ── Lemmy instance allowlist (SSRF protection) ──

const ALLOWED_INSTANCES = new Set([
  "lemmy.world",
  "lemmy.ml",
  "programming.dev",
  "lemm.ee",
  "sh.itjust.works",
  "feddit.de",
  "sopuli.xyz",
  "aussie.zone",
  "hexbear.net",
  "lemmygrad.ml",
  "discuss.tchncs.de",
  "midwest.social",
  "lemmy.dbzer0.com",
  "lemmy.blahaj.zone",
  "infosec.pub",
  "startrek.website",
  "mander.xyz",
  "lemmy.one",
]);

/** Validate instance against allowlist and reject SSRF attempts */
function validateInstance(instance: string): string | null {
  // Reject path traversal, IP addresses, localhost, port numbers
  if (
    instance.includes("/") ||
    instance.includes("\\") ||
    instance.includes(":") ||
    instance.includes("@") ||
    /^[\d.]+$/.test(instance) ||             // IPv4
    instance.includes("[") ||                 // IPv6
    /^localhost$/i.test(instance) ||
    /^127\.\d+\.\d+\.\d+$/.test(instance) ||
    /^0\.0\.0\.0$/.test(instance) ||
    /^10\.\d+\.\d+\.\d+$/.test(instance) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(instance) ||
    /^192\.168\.\d+\.\d+$/.test(instance)
  ) {
    return `Invalid instance: "${instance}" — contains disallowed characters or is a private/local address`;
  }

  if (!ALLOWED_INSTANCES.has(instance.toLowerCase())) {
    return `Instance "${instance}" is not in the allowlist. Allowed: ${[...ALLOWED_INSTANCES].join(", ")}`;
  }

  return null; // valid
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "TopAll" | "TopYear" | "TopMonth" | "TopWeek" | "New" | "Hot";
  instance?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const {
    query,
    per_page = config.DEFAULT_PER_PAGE,
    sort = "TopAll",
    instance = "lemmy.world",
  } = args;

  // SSRF protection: validate instance against allowlist
  const instanceError = validateInstance(instance);
  if (instanceError) {
    return fail("lemmy", query, instanceError, Date.now() - start);
  }

  try {
    const params = new URLSearchParams({
      q: query,
      type_: "Posts",
      sort,
      limit: String(Math.min(per_page, 20)),
    });

    const url = `https://${instance}/api/v3/search?${params}`;
    const res = await safeFetchJson<LemmySearchResponse>(url, {
      headers: { "User-Agent": "scout-mcp/1.0" },
    });

    if (!res.posts) {
      return fail("lemmy", query, "Unexpected response format", Date.now() - start);
    }

    const items = res.posts.slice(0, per_page).map((p) => ({
      id: p.post.id,
      title: p.post.name,
      body: p.post.body?.slice(0, 300) || "",
      url: p.post.url || p.post.ap_id,
      lemmy_url: p.post.ap_id,
      community: p.community.name,
      community_title: p.community.title,
      author: p.creator.name,
      score: p.counts.score,
      comments: p.counts.comments,
      upvotes: p.counts.upvotes,
      downvotes: p.counts.downvotes,
      date: p.post.published,
    }));

    return ok("lemmy", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("lemmy", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("lemmy_search", {
    description:
      "Search Lemmy (Fediverse Reddit alternative) for posts and discussions. Searches lemmy.world by default (largest instance, 30K+ daily active users). Returns title, score, comments, community, and content. Good for tech community discussions, especially post-Reddit-API communities.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
      sort: z
        .enum(["TopAll", "TopYear", "TopMonth", "TopWeek", "New", "Hot"])
        .default("TopAll")
        .describe("Sort order"),
      instance: z
        .string()
        .default("lemmy.world")
        .describe("Lemmy instance to search (default: lemmy.world)"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
