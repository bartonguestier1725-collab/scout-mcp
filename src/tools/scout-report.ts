/**
 * scout_report – 複合レポート（複数ソースを並列検索）
 *
 * 他ツールの execute() を import し、Promise.allSettled() で並列実行。
 * 1 ソースが失敗しても残りの結果を返す。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, type ToolResult } from "../types.js";

import { execute as hnSearch } from "./hackernews-search.js";
import { execute as npmSearch } from "./npm-search.js";
import { execute as githubSearch } from "./github-search.js";
import { execute as xSearch } from "./x-search.js";
import { execute as pypiSearch } from "./pypi-search.js";
import { execute as phSearch } from "./producthunt-search.js";
import { execute as devtoSearch } from "./devto-search.js";
import { execute as hashnodeSearch } from "./hashnode-search.js";
import { execute as lobstersSearch } from "./lobsters-search.js";
import { execute as stackexchangeSearch } from "./stackexchange-search.js";
import { execute as arxivSearch } from "./arxiv-search.js";
import { execute as redditSearch } from "./reddit-search.js";
import { execute as youtubeSearch } from "./youtube-search.js";
import { execute as zennSearch } from "./zenn-search.js";
import { execute as qiitaSearch } from "./qiita-search.js";
import { execute as semanticScholarSearch } from "./semantic-scholar-search.js";
import { execute as lemmySearch } from "./lemmy-search.js";
import { execute as gitlabSearch } from "./gitlab-search.js";

// ── Source registry ───────────────────────────────

type SourceId =
  | "hn" | "npm" | "github" | "x" | "pypi" | "producthunt"
  | "devto" | "hashnode" | "lobsters" | "stackexchange" | "arxiv"
  | "reddit" | "youtube" | "zenn"
  | "qiita" | "semantic_scholar" | "lemmy" | "gitlab";

const SOURCE_EXECUTORS: Record<SourceId, (query: string, perPage: number) => Promise<ToolResult>> = {
  hn: (q, n) => hnSearch({ query: q, per_page: n }),
  npm: (q, n) => npmSearch({ query: q, per_page: n }),
  github: (q, n) => githubSearch({ query: q, per_page: n }),
  x: (q, n) => xSearch({ query: q, per_page: n }),
  pypi: (q, n) => pypiSearch({ query: q, per_page: n }),
  producthunt: (q, n) => phSearch({ query: q, per_page: n }),
  devto: (q, n) => devtoSearch({ query: q, per_page: n }),
  hashnode: (q, n) => hashnodeSearch({ query: q, per_page: n }),
  lobsters: (q, n) => lobstersSearch({ query: q, per_page: n }),
  stackexchange: (q, n) => stackexchangeSearch({ query: q, per_page: n }),
  arxiv: (q, n) => arxivSearch({ query: q, per_page: n }),
  reddit: (q, n) => redditSearch({ query: q, per_page: n }),
  youtube: (q, n) => youtubeSearch({ query: q, per_page: n }),
  zenn: (q, n) => zennSearch({ query: q, per_page: n }),
  qiita: (q, n) => qiitaSearch({ query: q, per_page: n }),
  semantic_scholar: (q, n) => semanticScholarSearch({ query: q, per_page: n }),
  lemmy: (q, n) => lemmySearch({ query: q, per_page: n }),
  gitlab: (q, n) => gitlabSearch({ query: q, per_page: n }),
};

const ALL_SOURCES: SourceId[] = [
  "hn", "github", "npm", "pypi", "x", "producthunt",
  "devto", "hashnode", "lobsters", "stackexchange", "arxiv",
  "reddit", "youtube", "zenn",
  "qiita", "semantic_scholar", "lemmy", "gitlab",
];
const FREE_SOURCES: SourceId[] = [
  "hn", "github", "npm", "pypi",
  "devto", "hashnode", "lobsters", "stackexchange", "arxiv", "zenn",
  "qiita", "semantic_scholar", "lemmy", "gitlab",
];

// ── Focus presets ─────────────────────────────────

function resolveSources(
  sources: SourceId[] | undefined,
  focus: "trending" | "comprehensive" | "balanced",
): SourceId[] {
  if (sources && sources.length > 0) return sources;

  switch (focus) {
    case "trending":
      return ["hn", "x", "producthunt", "devto", "lobsters"];
    case "comprehensive":
      return ALL_SOURCES;
    case "balanced":
    default:
      return FREE_SOURCES;
  }
}

// ── Execute ───────────────────────────────────────

export async function execute(args: {
  query: string;
  sources?: SourceId[];
  focus?: "trending" | "comprehensive" | "balanced";
  per_page?: number;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, sources: rawSources, focus = "balanced", per_page = 5 } = args;

  try {
    const sources = resolveSources(rawSources as SourceId[] | undefined, focus);

    // Run all sources in parallel
    const entries = sources.map((id) => ({
      id,
      promise: SOURCE_EXECUTORS[id](query, per_page),
    }));

    const results = await Promise.allSettled(entries.map((e) => e.promise));

    const report: Record<string, ToolResult> = {};
    let totalCount = 0;
    let totalCostUsd = 0;
    const costBreakdown: Record<string, number> = {};

    results.forEach((r, i) => {
      const id = entries[i].id;
      if (r.status === "fulfilled") {
        report[id] = r.value;
        totalCount += r.value.count;
        if (r.value.cost_estimate) {
          totalCostUsd += r.value.cost_estimate.usd;
          costBreakdown[id] = r.value.cost_estimate.usd;
        }
      } else {
        report[id] = fail(id, query, String(r.reason), Date.now() - start);
      }
    });

    const summary = {
      query,
      focus,
      sources_requested: sources,
      sources_succeeded: Object.values(report).filter((r) => r.success).length,
      sources_failed: Object.values(report).filter((r) => !r.success).length,
      total_results: totalCount,
    };

    const data = { summary, results: report };
    const cost = totalCostUsd > 0 ? { usd: totalCostUsd, breakdown: costBreakdown } : undefined;

    return ok("scout_report", query, data, totalCount, Date.now() - start, cost);
  } catch (err) {
    return fail("scout_report", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ──────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("scout_report", {
    description:
      "Run a multi-source intelligence report. Searches across 18 sources (HN, GitHub, npm, PyPI, X, Product Hunt, Dev.to, Hashnode, Lobste.rs, StackExchange, ArXiv, Reddit, YouTube, Zenn, Qiita, Semantic Scholar, Lemmy, GitLab) in parallel. Use 'focus' to control source selection: 'balanced' (14 free APIs), 'trending' (HN+X+PH+Dev.to+Lobsters), 'comprehensive' (all 18). Or specify exact sources. X search uses xAI Grok API (~$0.005/call). Reddit requires API keys. YouTube requires API key.",
    inputSchema: {
      query: z.string().describe("Search query to scout across sources"),
      sources: z
        .array(z.enum([
          "hn", "npm", "github", "x", "pypi", "producthunt",
          "devto", "hashnode", "lobsters", "stackexchange", "arxiv",
          "reddit", "youtube", "zenn",
          "qiita", "semantic_scholar", "lemmy", "gitlab",
        ]))
        .optional()
        .describe("Specific sources to search (overrides focus)"),
      focus: z
        .enum(["trending", "comprehensive", "balanced"])
        .default("balanced")
        .describe("Preset: balanced=14 free APIs, trending=HN+X+PH+Dev.to+Lobsters, comprehensive=all 18"),
      per_page: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Results per source"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
