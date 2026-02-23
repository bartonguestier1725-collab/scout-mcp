#!/usr/bin/env node
/**
 * Scout MCP – CLI テストツール
 *
 * Usage:
 *   node build/cli.js <tool_name> '<json_args>'
 *
 * Examples:
 *   node build/cli.js hackernews_search '{"query":"MCP server","per_page":3}'
 *   node build/cli.js github_search '{"query":"x402","sort":"stars"}'
 *   node build/cli.js scout_report '{"query":"LLM agents","sources":["hn","github","npm"]}'
 */

import "dotenv/config";

import { execute as hnSearch } from "./tools/hackernews-search.js";
import { execute as npmSearch } from "./tools/npm-search.js";
import { execute as githubSearch } from "./tools/github-search.js";
import { execute as githubRepoInfo } from "./tools/github-repo-info.js";
import { execute as xSearch } from "./tools/x-search.js";
import { execute as pypiSearch } from "./tools/pypi-search.js";
import { execute as phSearch } from "./tools/producthunt-search.js";
import { execute as scoutReport } from "./tools/scout-report.js";
import { execute as bazaarSearch } from "./tools/bazaar-search.js";
import { execute as devtoSearch } from "./tools/devto-search.js";
import { execute as hashnodeSearch } from "./tools/hashnode-search.js";
import { execute as lobstersSearch } from "./tools/lobsters-search.js";
import { execute as stackexchangeSearch } from "./tools/stackexchange-search.js";
import { execute as arxivSearch } from "./tools/arxiv-search.js";
import { execute as redditSearch } from "./tools/reddit-search.js";
import { execute as youtubeSearch } from "./tools/youtube-search.js";
import { execute as zennSearch } from "./tools/zenn-search.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: Record<string, (args: any) => Promise<unknown>> = {
  hackernews_search: hnSearch,
  npm_search: npmSearch,
  github_search: githubSearch,
  github_repo_info: githubRepoInfo,
  x_search: xSearch,
  pypi_search: pypiSearch,
  producthunt_search: phSearch,
  scout_report: scoutReport,
  bazaar_search: bazaarSearch,
  devto_search: devtoSearch,
  hashnode_search: hashnodeSearch,
  lobsters_search: lobstersSearch,
  stackexchange_search: stackexchangeSearch,
  arxiv_search: arxivSearch,
  reddit_search: redditSearch,
  youtube_search: youtubeSearch,
  zenn_search: zennSearch,
};

async function main() {
  const [toolName, argsJson] = process.argv.slice(2);

  if (!toolName || toolName === "--help" || toolName === "-h") {
    console.log("Usage: scout-cli <tool_name> '<json_args>'");
    console.log("\nAvailable tools:");
    for (const name of Object.keys(TOOLS)) {
      console.log(`  ${name}`);
    }
    process.exit(0);
  }

  const tool = TOOLS[toolName];
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    console.error(`Available: ${Object.keys(TOOLS).join(", ")}`);
    process.exit(1);
  }

  let args: Record<string, unknown>;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    console.error(`Invalid JSON args: ${argsJson}`);
    process.exit(1);
  }

  const result = await tool(args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
