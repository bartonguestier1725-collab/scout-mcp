/**
 * youtube_search – YouTube 動画検索 (Data API v3)
 *
 * API: https://www.googleapis.com/youtube/v3/search
 * 認証: API Key (YOUTUBE_API_KEY)
 * コスト: 無料（10,000 units/day、search = 100 units/call → 100 回/日）
 *
 * 動画の字幕テキストは youtube-transcript-api (Python) が必要なため、
 * このツールではメタデータ（タイトル・説明・チャンネル）のみ返す。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeFetchJson } from "../fetch-utils.js";
import { ok, fail, type ToolResult } from "../types.js";
import { config } from "../config.js";

// ── Response types ───────────────────────────────

interface YtSearchItem {
  id: { videoId?: string; channelId?: string; playlistId?: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
    thumbnails: {
      default: { url: string };
      medium?: { url: string };
    };
    liveBroadcastContent: string;
  };
}

interface YtSearchResponse {
  items: YtSearchItem[];
  pageInfo: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}

// ── Execute ──────────────────────────────────────

export async function execute(args: {
  query: string;
  per_page?: number;
  order?: "relevance" | "date" | "viewCount" | "rating";
  type?: "video" | "channel" | "playlist";
}): Promise<ToolResult> {
  const start = Date.now();
  const { query, per_page = config.DEFAULT_PER_PAGE, order = "relevance", type = "video" } = args;

  if (!config.YOUTUBE_API_KEY) {
    return fail(
      "youtube",
      query,
      "YOUTUBE_API_KEY not configured",
      Date.now() - start,
    );
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type,
      maxResults: String(Math.min(per_page, 50)),
      order,
      key: config.YOUTUBE_API_KEY,
    });

    const url = `https://www.googleapis.com/youtube/v3/search?${params}`;
    const res = await safeFetchJson<YtSearchResponse>(url);

    const items = res.items
      .filter((item) => item.id.videoId) // Only videos
      .map((item) => ({
        id: item.id.videoId!,
        title: item.snippet.title,
        description: item.snippet.description,
        channel: item.snippet.channelTitle,
        channel_id: item.snippet.channelId,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default.url,
        date: item.snippet.publishedAt,
        is_live: item.snippet.liveBroadcastContent === "live",
      }));

    return ok("youtube", query, items, items.length, Date.now() - start);
  } catch (err) {
    return fail("youtube", query, err instanceof Error ? err.message : String(err), Date.now() - start);
  }
}

// ── MCP Registration ─────────────────────────────

export function register(server: McpServer): void {
  server.registerTool("youtube_search", {
    description:
      "Search YouTube for videos. Returns title, description, channel name, thumbnail URL, and video URL. Great for tutorials, demos, and educational content. Requires YOUTUBE_API_KEY.",
    inputSchema: {
      query: z.string().describe("Search query"),
      per_page: z.number().min(1).max(50).default(10).describe("Results per page"),
      order: z
        .enum(["relevance", "date", "viewCount", "rating"])
        .default("relevance")
        .describe("Sort order"),
      type: z
        .enum(["video", "channel", "playlist"])
        .default("video")
        .describe("Result type filter"),
    },
  }, async (args) => {
    const result = await execute(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  });
}
