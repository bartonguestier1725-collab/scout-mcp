/**
 * gitlab_search – GitLab プロジェクト検索（公式 API v4）
 *
 * API: https://gitlab.com/api/v4/projects
 * 認証: 不要（400 req/10min）
 * コスト: 無料
 *
 * GitHub にないプロジェクト（エンタープライズ OSS、EU プロジェクト等）をカバー。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface GitLabProject {
  id: number;
  name: string;
  name_with_namespace: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  star_count: number;
  forks_count: number;
  open_issues_count: number | null;
  last_activity_at: string;
  created_at: string;
  default_branch: string;
  topics: string[];
  readme_url: string | null;
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "stars" | "updated" | "name";
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "stars" } = args;

  try {
    const orderBy = sort === "stars" ? "star_count" : sort === "updated" ? "last_activity_at" : "name";

    const params = new URLSearchParams({
      search: query,
      order_by: orderBy,
      sort: "desc",
      per_page: String(Math.min(per_page, 20)),
      visibility: "public",
    });

    const url = `https://gitlab.com/api/v4/projects?${params}`;
    const projects = await safeFetchJson<GitLabProject[]>(url);

    const items = projects.slice(0, per_page).map((p) => ({
      id: p.id,
      name: p.name,
      full_name: p.path_with_namespace,
      description: p.description || "",
      url: p.web_url,
      stars: p.star_count,
      forks: p.forks_count,
      topics: p.topics,
      default_branch: p.default_branch,
      last_activity: p.last_activity_at,
      created: p.created_at,
    }));

    return ok("gitlab", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("gitlab", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("gitlab_search", {
    description:
      "Search GitLab.com for public projects (the second largest code hosting platform). Returns name, description, stars, forks, topics, and activity. Covers enterprise OSS and projects not on GitHub.",
    inputSchema: {
      query: z.string().describe("Search query for GitLab projects"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
      sort: z
        .enum(["stars", "updated", "name"])
        .default("stars")
        .describe("Sort order"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
