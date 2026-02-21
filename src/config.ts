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
  NETWORK: process.env.NETWORK ?? "eip155:8453",
  X402_PORT: Number(process.env.X402_PORT) || 4023,
  FACILITATOR_URL:
    process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID ?? "",
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET ?? "",

  // Timeouts & limits
  TIMEOUT_MS: 10_000,
  DEFAULT_PER_PAGE: 10,
} as const;
