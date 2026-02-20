/**
 * Scout MCP – centralised configuration
 *
 * Environment variables are read once at import time.
 * Missing optional keys are empty strings (tools check at execution time).
 */

import "dotenv/config";

export const config = {
  // xAI Grok API (required for x_search)
  XAI_API_KEY: process.env.XAI_API_KEY ?? "",

  // GitHub REST API (recommended – raises rate limit from 10→30 req/min)
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",

  // Product Hunt GraphQL API
  PH_CLIENT_ID: process.env.PH_CLIENT_ID ?? "",
  PH_CLIENT_SECRET: process.env.PH_CLIENT_SECRET ?? "",

  // Timeouts & limits
  TIMEOUT_MS: 10_000,
  DEFAULT_PER_PAGE: 10,
} as const;
