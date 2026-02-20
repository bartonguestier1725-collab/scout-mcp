/**
 * pypi_search – PyPI パッケージ検索
 *
 * PyPI の公式 Search API は廃止済み & Web 検索は Cloudflare で保護。
 * 代替手段:
 *  1. Google Custom Search (`site:pypi.org`) … API key 必要 → 却下
 *  2. PyPI JSON API (`/pypi/<name>/json`) で直接 lookup → 確実
 *  3. libraries.io search → API key 必要 → 却下
 *
 * 方針: クエリをパッケージ名候補として扱い、
 *  - 完全一致: JSON API で直接取得
 *  - 部分一致: ハイフン/アンダースコア正規化で複数候補を試す
 *
 * 認証: 不要 / コスト: 無料
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";

// ── PyPI JSON API response ────────────────────────

interface PypiInfo {
  name: string;
  version: string;
  summary: string;
  home_page: string | null;
  project_url: string;
  project_urls: Record<string, string> | null;
  author: string | null;
  author_email: string | null;
  license: string | null;
  requires_python: string | null;
  keywords: string | null;
  classifiers: string[];
}

interface PypiRelease {
  upload_time: string;
  size: number;
  packagetype: string;
}

interface PypiResponse {
  info: PypiInfo;
  releases: Record<string, PypiRelease[]>;
}

// ── Helpers ───────────────────────────────────────

/** Generate candidate package names from a query string */
function generateCandidates(query: string): string[] {
  const base = query.trim().toLowerCase();
  const candidates = new Set<string>();

  // Exact query
  candidates.add(base);

  // Normalize separators
  candidates.add(base.replace(/[\s_]+/g, "-"));
  candidates.add(base.replace(/[\s-]+/g, "_"));

  // Common prefixes/suffixes for Python packages
  const hyphenated = base.replace(/[\s_]+/g, "-");
  candidates.add(`python-${hyphenated}`);
  candidates.add(`py${hyphenated}`);
  candidates.add(`${hyphenated}-python`);
  candidates.add(`${hyphenated}-py`);

  // If multi-word, try joining without separator
  if (base.includes(" ") || base.includes("-") || base.includes("_")) {
    candidates.add(base.replace(/[\s_-]+/g, ""));
  }

  return [...candidates];
}

async function fetchPackageInfo(
  name: string,
): Promise<{ name: string; info: PypiInfo; releaseCount: number; latestUpload: string | null } | null> {
  try {
    const res = await safeFetchJson<PypiResponse>(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
      { timeoutMs: 5_000 },
    );

    const releaseVersions = Object.keys(res.releases);
    const latestFiles = res.releases[res.info.version] ?? [];
    const latestUpload = latestFiles.length > 0 ? latestFiles[0].upload_time : null;

    return {
      name: res.info.name,
      info: res.info,
      releaseCount: releaseVersions.length,
      latestUpload,
    };
  } catch {
    return null;
  }
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = 5 } = args;

  try {
    const candidates = generateCandidates(query);

    // Try all candidates in parallel
    const results = await Promise.all(candidates.map(fetchPackageInfo));

    // Deduplicate by normalized name
    const seen = new Set<string>();
    const items = results
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .filter((r) => {
        const key = r.info.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, per_page)
      .map((r) => ({
        name: r.info.name,
        version: r.info.version,
        summary: r.info.summary || "",
        pypi_url: `https://pypi.org/project/${r.info.name}/`,
        homepage: r.info.home_page || r.info.project_urls?.Homepage || null,
        repository:
          r.info.project_urls?.Repository ||
          r.info.project_urls?.Source ||
          r.info.project_urls?.GitHub ||
          null,
        author: r.info.author,
        license: r.info.license,
        requires_python: r.info.requires_python,
        keywords: r.info.keywords
          ? r.info.keywords.split(",").map((k) => k.trim()).filter(Boolean)
          : [],
        release_count: r.releaseCount,
        latest_upload: r.latestUpload,
      }));

    return ok("pypi", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("pypi", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("pypi_search", {
    description:
      "Look up Python packages on PyPI by name. Tries multiple name variants (hyphenated, underscored, with py- prefix). For best results, use the exact or approximate package name. Returns version, summary, links, and metadata.",
    inputSchema: {
      query: z.string().describe("Package name or approximate name to look up on PyPI"),
      per_page: z.number().min(1).max(20).default(5).describe("Max results to return"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
