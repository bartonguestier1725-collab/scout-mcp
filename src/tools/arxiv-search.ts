/**
 * arxiv_search – ArXiv 学術論文検索
 *
 * API: http://export.arxiv.org/api/query
 * 認証: 不要 / コスト: 無料
 * レート制限: 3秒間隔推奨
 *
 * Atom XML レスポンスを正規表現でパース（外部 XML パーサー不要）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchText } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── XML parsing helpers (no external dependency) ─

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim().replace(/\s+/g, " ") ?? "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"[^>]*/?>`, "s"));
  return match?.[1] ?? "";
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = regex.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  sort?: "relevance" | "date";
  category?: string;
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, sort = "relevance", category } = args;

  try {
    let searchQuery = `all:${encodeURIComponent(query)}`;
    if (category) {
      searchQuery += `+AND+cat:${encodeURIComponent(category)}`;
    }

    const sortBy = sort === "date" ? "submittedDate" : "relevance";
    const sortOrder = "descending";

    const url =
      `http://export.arxiv.org/api/query?search_query=${searchQuery}` +
      `&start=0&max_results=${Math.min(per_page, 50)}` +
      `&sortBy=${sortBy}&sortOrder=${sortOrder}`;

    const xml = await safeFetchText(url);

    // Parse entries from Atom XML
    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

    const items = entryBlocks.map((entry) => {
      const id = extractTag(entry, "id");
      const arxivId = id.replace("http://arxiv.org/abs/", "");
      const authors = extractAllTags(entry, "name");

      return {
        id: arxivId,
        title: extractTag(entry, "title"),
        summary: extractTag(entry, "summary").slice(0, 300),
        authors,
        url: id,
        pdf_url: extractAttr(entry, "link", "title")
          ? `http://arxiv.org/pdf/${arxivId}`
          : extractTag(entry, "id").replace("/abs/", "/pdf/"),
        categories: extractAllTags(entry, "category")
          .map(() => "")
          .filter(Boolean), // categories are attributes, handle below
        date: extractTag(entry, "published"),
        updated: extractTag(entry, "updated"),
      };
    });

    // Fix categories: extract from attributes
    const entriesWithCats = entryBlocks.map((entry, i) => {
      const catMatches = [...entry.matchAll(/category[^>]*term="([^"]+)"/g)];
      return { ...items[i], categories: catMatches.map((m) => m[1]) };
    });

    return ok("arxiv", query, entriesWithCats, entriesWithCats.length, Date.now() - start);
  } catch (err) {
    return fail("arxiv", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("arxiv_search", {
    description:
      "Search ArXiv for academic papers and preprints. Returns title, authors, abstract summary, PDF link, and categories. Great for cutting-edge research in CS, ML, physics, and mathematics.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
      sort: z
        .enum(["relevance", "date"])
        .default("relevance")
        .describe("Sort by relevance or submission date"),
      category: z
        .string()
        .optional()
        .describe("ArXiv category filter (e.g. cs.AI, cs.CL, stat.ML)"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
