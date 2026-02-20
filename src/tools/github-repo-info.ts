/**
 * github_repo_info – GitHub リポジトリ詳細情報
 *
 * API: https://docs.github.com/en/rest/repos/repos#get-a-repository
 * 認証: GITHUB_TOKEN 推奨
 * コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── GitHub response types ─────────────────────────

interface GhRepoDetail {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  subscribers_count: number;
  network_count: number;
  language: string | null;
  topics: string[];
  license: { spdx_id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  default_branch: string;
  homepage: string | null;
  archived: boolean;
  fork: boolean;
  size: number;
}

interface GhContributor {
  login: string;
  contributions: number;
  html_url: string;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  published_at: string;
  prerelease: boolean;
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  owner: string;
  repo: string;
  include_contributors?: boolean;
  include_releases?: boolean;
}): Promise<ToolResult> {
  const start = Date.now();
  const { owner, repo, include_contributors = false, include_releases = false } = args;
  const slug = `${owner}/${repo}`;

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
    }

    // Fetch repo detail + optional extras in parallel
    const fetches: Promise<unknown>[] = [
      safeFetchJson<GhRepoDetail>(`https://api.github.com/repos/${slug}`, { headers }),
    ];
    if (include_contributors) {
      fetches.push(
        safeFetchJson<GhContributor[]>(
          `https://api.github.com/repos/${slug}/contributors?per_page=10`,
          { headers },
        ),
      );
    }
    if (include_releases) {
      fetches.push(
        safeFetchJson<GhRelease[]>(
          `https://api.github.com/repos/${slug}/releases?per_page=5`,
          { headers },
        ),
      );
    }

    const results = await Promise.all(fetches);
    const detail = results[0] as GhRepoDetail;

    let idx = 1;
    const contributors = include_contributors
      ? (results[idx++] as GhContributor[]).map((c) => ({
          login: c.login,
          contributions: c.contributions,
          url: c.html_url,
        }))
      : undefined;

    const releases = include_releases
      ? (results[idx++] as GhRelease[]).map((r) => ({
          tag: r.tag_name,
          name: r.name,
          published: r.published_at,
          prerelease: r.prerelease,
        }))
      : undefined;

    const data = {
      name: detail.full_name,
      url: detail.html_url,
      description: detail.description,
      homepage: detail.homepage,
      stars: detail.stargazers_count,
      forks: detail.forks_count,
      watchers: detail.watchers_count,
      open_issues: detail.open_issues_count,
      subscribers: detail.subscribers_count,
      network: detail.network_count,
      language: detail.language,
      topics: detail.topics,
      license: detail.license ? { id: detail.license.spdx_id, name: detail.license.name } : null,
      default_branch: detail.default_branch,
      size_kb: detail.size,
      archived: detail.archived,
      is_fork: detail.fork,
      created: detail.created_at,
      updated: detail.updated_at,
      pushed: detail.pushed_at,
      ...(contributors && { top_contributors: contributors }),
      ...(releases && { recent_releases: releases }),
    };

    return ok("github_repo", slug, data, 1, Date.now() - start);
  } catch (err) {
    return fail("github_repo", slug, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("github_repo_info", {
    description:
      "Get detailed information about a specific GitHub repository: stars, forks, contributors, releases, license, topics, and more.",
    inputSchema: {
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      include_contributors: z
        .boolean()
        .default(false)
        .describe("Include top 10 contributors"),
      include_releases: z
        .boolean()
        .default(false)
        .describe("Include 5 most recent releases"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
