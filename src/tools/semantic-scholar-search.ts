/**
 * semantic_scholar_search – Semantic Scholar 論文検索（公式 API）
 *
 * API: https://api.semanticscholar.org/graph/v1/paper/search
 * 認証: 不要（5000 req/5min shared）/ 無料キーで 1 req/sec dedicated
 * コスト: 無料
 *
 * 2億件+の論文を検索。引用数・被引用数・影響度スコア付き。
 * ArXiv の上位互換（全分野カバー + 引用グラフ）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface S2Paper {
  paperId: string;
  title: string;
  abstract: string | null;
  url: string;
  year: number | null;
  citationCount: number;
  influentialCitationCount: number;
  authors: Array<{ authorId: string; name: string }>;
  publicationTypes: string[] | null;
  journal: { name: string } | null;
  openAccessPdf: { url: string } | null;
  fieldsOfStudy: string[] | null;
}

interface S2Response {
  total: number;
  data: S2Paper[];
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  year?: string;
  fields_of_study?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, year, fields_of_study } = args;

  try {
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(per_page, 20)),
      fields: "paperId,title,abstract,url,year,citationCount,influentialCitationCount,authors,publicationTypes,journal,openAccessPdf,fieldsOfStudy",
    });

    if (year) params.set("year", year);
    if (fields_of_study) params.set("fieldsOfStudy", fields_of_study);

    const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
    const headers: Record<string, string> = {};

    const s2Key = process.env.S2_API_KEY;
    if (s2Key) {
      headers["x-api-key"] = s2Key;
    }

    const res = await safeFetchJson<S2Response>(url, { headers });

    const items = (res.data || []).map((p) => ({
      id: p.paperId,
      title: p.title,
      abstract: p.abstract?.slice(0, 300) || null,
      url: p.url,
      pdf_url: p.openAccessPdf?.url || null,
      year: p.year,
      citations: p.citationCount,
      influential_citations: p.influentialCitationCount,
      authors: p.authors.map((a) => a.name),
      journal: p.journal?.name || null,
      fields: p.fieldsOfStudy || [],
      types: p.publicationTypes || [],
    }));

    return ok("semantic_scholar", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("semantic_scholar", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("semantic_scholar_search", {
    description:
      "Search Semantic Scholar for academic papers across all disciplines (200M+ papers). Returns title, abstract, citations, influential citations, authors, journal, open access PDF link, and fields of study. Superior to ArXiv alone because it covers all fields and includes citation graph data.",
    inputSchema: {
      query: z.string().describe("Search query for papers"),
      per_page: z.number().min(1).max(20).default(10).describe("Results per page"),
      year: z.string().optional().describe("Filter by year or range (e.g. '2024', '2020-2024')"),
      fields_of_study: z.string().optional().describe("Filter by field (e.g. 'Computer Science', 'Medicine')"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
