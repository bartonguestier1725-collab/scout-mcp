/**
 * Scout MCP – centralised configuration
 *
 * Environment variables are read once at import time.
 * Missing optional keys are empty strings (tools check at execution time).
 *
 * dotenv は process.cwd() ではなくスクリプトの場所を基準に .env を探す。
 * MCP サーバーとして起動される場合、cwd がプロジェクトルートとは限らないため。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

// dotenv v17 は config() 呼び出し時に console.log でログを出す。
// MCP サーバーでは stdout = JSON-RPC 専用なので、手動で parse + 注入する。
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
try {
  const parsed = parse(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // .env が存在しない場合は process.env のみに依存
}

export const config = {
  // xAI Grok API (required for x_search)
  XAI_API_KEY: process.env.XAI_API_KEY ?? "",

  // GitHub REST API (recommended – raises rate limit from 10→30 req/min)
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",

  // Product Hunt GraphQL API
  PH_CLIENT_ID: process.env.PH_CLIENT_ID ?? "",
  PH_CLIENT_SECRET: process.env.PH_CLIENT_SECRET ?? "",

  // x402 payment settings
  EVM_ADDRESS: process.env.EVM_ADDRESS ?? "",
  SOLANA_PAY_TO: process.env.SOLANA_PAY_TO ?? "",
  NETWORK: process.env.NETWORK ?? "eip155:8453",
  X402_PORT: Number(process.env.APIFY_CONTAINER_PORT) || Number(process.env.X402_PORT) || 4023,
  IS_APIFY: process.env.APIFY_IS_AT_HOME === "1",
  FACILITATOR_URL:
    process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID ?? "",
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET ?? "",

  // Gemini (Deep Research synthesis)
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",

  // Pricing (env-configurable for instant adjustment without code change)
  PRICE_LOW: process.env.PRICE_LOW ?? "$0.01",
  PRICE_X: process.env.PRICE_X ?? "$0.20",
  PRICE_XFULL: process.env.PRICE_XFULL ?? "$0.25",
  PRICE_RESEARCH: process.env.PRICE_RESEARCH ?? "$0.25",
  PRICE_RESEARCH_DEEP: process.env.PRICE_RESEARCH_DEEP ?? "$0.50",
  XAI_COST_PER_CALL: Number(process.env.XAI_COST_PER_CALL) || 0.05,

  // RapidAPI proxy authentication (optional — empty = disabled)
  RAPIDAPI_PROXY_SECRET: process.env.RAPIDAPI_PROXY_SECRET ?? "",

  // StackExchange (optional — raises rate limit from 300→10,000/day)
  SE_API_KEY: process.env.SE_API_KEY ?? "",

  // Reddit (required for reddit_search — free for non-commercial/personal use)
  REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID ?? "",
  REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET ?? "",

  // YouTube Data API v3 (required for youtube_search — 10,000 units/day free)
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? "",

  // Timeouts & limits
  TIMEOUT_MS: 15_000,
  DEFAULT_PER_PAGE: 10,
} as const;
