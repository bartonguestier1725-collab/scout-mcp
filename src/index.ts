#!/usr/bin/env node
/**
 * Scout MCP – MCP server entry point (StdioServerTransport)
 *
 * All console.log は禁止（stdout = MCP プロトコル専用）。
 * デバッグ出力は console.error (stderr) のみ。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Tool registrations
import { register as registerHnSearch } from "./tools/hackernews-search.js";
import { register as registerNpmSearch } from "./tools/npm-search.js";
import { register as registerGithubSearch } from "./tools/github-search.js";
import { register as registerGithubRepoInfo } from "./tools/github-repo-info.js";
import { register as registerXSearch } from "./tools/x-search.js";
import { register as registerPypiSearch } from "./tools/pypi-search.js";
import { register as registerProducthuntSearch } from "./tools/producthunt-search.js";
import { register as registerScoutReport } from "./tools/scout-report.js";
import { register as registerBazaarSearch } from "./tools/bazaar-search.js";
import { register as registerDevtoSearch } from "./tools/devto-search.js";
import { register as registerHashnodeSearch } from "./tools/hashnode-search.js";
import { register as registerLobstersSearch } from "./tools/lobsters-search.js";
import { register as registerStackexchangeSearch } from "./tools/stackexchange-search.js";
import { register as registerArxivSearch } from "./tools/arxiv-search.js";
import { register as registerRedditSearch } from "./tools/reddit-search.js";
import { register as registerYoutubeSearch } from "./tools/youtube-search.js";
import { register as registerZennSearch } from "./tools/zenn-search.js";

const server = new McpServer({
  name: "scout-mcp",
  version: "0.2.0",
});

// Register all tools
registerHnSearch(server);
registerNpmSearch(server);
registerGithubSearch(server);
registerGithubRepoInfo(server);
registerXSearch(server);
registerPypiSearch(server);
registerProducthuntSearch(server);
registerScoutReport(server);
registerBazaarSearch(server);
registerDevtoSearch(server);
registerHashnodeSearch(server);
registerLobstersSearch(server);
registerStackexchangeSearch(server);
registerArxivSearch(server);
registerRedditSearch(server);
registerYoutubeSearch(server);
registerZennSearch(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[scout-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[scout-mcp] Fatal:", err);
  process.exit(1);
});
