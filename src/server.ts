#!/usr/bin/env node
/**
 * Scout MCP – HTTP server with x402 payment middleware
 *
 * Express HTTP モード。既存の tools/*.ts の execute() を HTTP エンドポイントとして公開し、
 * x402 ミドルウェアでマイクロペイメント課金する。
 *
 * MCP モード (index.ts) と HTTP モード (server.ts) は同じツール群を共有。
 */

import express from "express";
import type { Request, Response } from "express";
import { paymentMiddleware } from "@x402/express";
import {
  x402ResourceServer,
  HTTPFacilitatorClient,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions";
import { createFacilitatorConfig } from "@coinbase/x402";

import { config } from "./config.js";

// Tool imports
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
import { execute as semanticScholarSearch } from "./tools/semantic-scholar-search.js";
import { execute as gitlabSearch } from "./tools/gitlab-search.js";
// Reddit: MCP-only (public .json feeds, commercial redistribution unclear)
// YouTube: MCP-only (YouTube Data API ToS restriction)
// Qiita: MCP-only (unofficial API, personal use only)
// Lemmy: MCP-only (community instance, personal use)

// ── Apify Actor (lazy-loaded only when running on Apify) ────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Actor: any = null;
if (config.IS_APIFY) {
  const apify = await import("apify");
  Actor = apify.Actor;
  await Actor.init();
  console.error("[scout-mcp] Apify Actor initialized");
}

// ── Apify PPE charge helper ─────────────────────────────────

async function apifyCharge(eventName: string): Promise<boolean> {
  if (!Actor) return true; // non-Apify: always OK
  const result = await Actor.charge({ eventName });
  console.error(`[apify-charge] event=${eventName} limitReached=${result.eventChargeLimitReached}`);
  return !result.eventChargeLimitReached;
}

// ── RapidAPI X rate limiter (per-user monthly quota) ────────

/** X call limits per RapidAPI plan (monthly). Plans without X access get 0. */
const RAPIDAPI_X_LIMITS: Record<string, number> = {
  BASIC: 0,        // X not available
  PRO: 0,          // X not available
  ULTRA: 100,      // 100 X calls/month → max cost $5, profit $14.99
  MEGA: 500,       // 500 X calls/month → max cost $25, profit $24.99
};

/** Track X usage: key = "YYYY-MM:{user}", value = count */
const rapidapiXUsage = new Map<string, number>();

function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Check if a RapidAPI request is allowed to use X endpoints.
 * Returns null if allowed, or an error response object if blocked.
 */
function checkRapidApiXLimit(req: Request): { status: number; body: object } | null {
  if ((req as any)._channel !== "rapidapi") return null; // non-RapidAPI: no limit

  const plan = (req.headers["x-rapidapi-subscription"] as string || "BASIC").toUpperCase();
  const limit = RAPIDAPI_X_LIMITS[plan] ?? 0;

  if (limit === 0) {
    return {
      status: 403,
      body: {
        error: `X/Twitter search is not available on the ${plan} plan. Please upgrade to ULTRA or higher.`,
        plan,
        upgrade_url: "https://rapidapi.com/bartonguestier1725-collab/api/scout-multi-source-search/pricing",
      },
    };
  }

  const userId = req.headers["x-rapidapi-user"] as string || "unknown";
  const key = `${getMonthKey()}:${userId}`;
  const used = rapidapiXUsage.get(key) || 0;

  if (used >= limit) {
    return {
      status: 429,
      body: {
        error: `Monthly X search limit reached (${limit} calls/month on ${plan} plan).`,
        plan,
        used,
        limit,
        resets: "1st of next month",
      },
    };
  }

  // Increment usage
  rapidapiXUsage.set(key, used + 1);

  // Cleanup: remove keys from previous months to prevent memory leak
  const currentMonth = getMonthKey();
  for (const k of rapidapiXUsage.keys()) {
    if (!k.startsWith(currentMonth)) rapidapiXUsage.delete(k);
  }

  return null;
}

// ── Stats (in-memory, resets on restart) ────────────────────

const stats = {
  started_at: new Date().toISOString(),
  requests_total: 0,
  requests_by_endpoint: {} as Record<string, number>,
  requests_by_channel: { x402: 0, rapidapi: 0, apify: 0, free: 0 } as Record<string, number>,
  errors_total: 0,
  x_calls: 0,
  x_cost_estimate: 0,
  // Per-call cost tracking from xAI API response (for price-change detection)
  x_cost_per_call_sum: 0,
  x_cost_per_call_recent: [] as number[], // last 20 calls for rolling average
};

// ── Helper: xAI cost tracking ───────────────────────────────

import type { ToolResult } from "./types.js";

const ROLLING_WINDOW = 20;

function trackXCost(result: ToolResult): void {
  const cost = result.cost_estimate?.usd ?? config.XAI_COST_PER_CALL;
  stats.x_cost_estimate += cost;
  stats.x_cost_per_call_sum += cost;
  stats.x_cost_per_call_recent.push(cost);
  if (stats.x_cost_per_call_recent.length > ROLLING_WINDOW) {
    stats.x_cost_per_call_recent.shift();
  }
}

function trackXCostFromReport(result: ToolResult): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = result.data as any;
  const xResult = data?.results?.x;
  if (xResult?.cost_estimate?.usd) {
    trackXCost(xResult as ToolResult);
  } else {
    // Fallback: use configured average
    stats.x_cost_estimate += config.XAI_COST_PER_CALL;
    stats.x_cost_per_call_sum += config.XAI_COST_PER_CALL;
  }
}

function getXCostHealth(): {
  avg_cost_per_call: number;
  configured_price: string;
  margin_pct: number;
  alert: boolean;
} {
  const avg = stats.x_calls > 0
    ? stats.x_cost_per_call_sum / stats.x_calls
    : config.XAI_COST_PER_CALL;
  const priceNum = parseFloat(config.PRICE_X.replace("$", ""));
  const margin = priceNum > 0 ? ((priceNum - avg) / priceNum) * 100 : 0;
  return {
    avg_cost_per_call: Math.round(avg * 10000) / 10000,
    configured_price: config.PRICE_X,
    margin_pct: Math.round(margin),
    alert: margin < 40, // Alert when margin drops below 40%
  };
}

// ── Helper: query param extraction ──────────────────────────

const q = (req: Request) => String(req.query.q || req.query.query || "");
const MAX_PER_PAGE = 50;
const MAX_PER_PAGE_COSTLY = 20; // X search & scout_report — higher upstream cost
const perPage = (req: Request, max = MAX_PER_PAGE) => {
  if (!req.query.per_page) return undefined;
  const n = Number(req.query.per_page);
  return Number.isFinite(n) ? Math.round(Math.max(1, Math.min(n, max))) : undefined;
};
const sanitizeError = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip credential-like patterns (key=..., token: ..., etc.)
  return msg.replace(/(?:key|token|secret|password|authorization)[=: ]\S+/gi, "[REDACTED]");
};

// Return 502 when upstream tool fails (success:false).
// This prevents x402 settlement (which checks statusCode < 400).
const sendResult = (res: Response, result: ToolResult): void => {
  res.status(result.success ? 200 : 502).json(result);
};

// ── Main ────────────────────────────────────────────────────

async function startServer() {
  if (!config.EVM_ADDRESS && !config.IS_APIFY) {
    throw new Error(
      "EVM_ADDRESS not set. Configure .env before starting the HTTP server.",
    );
  }

  // --- Express app ---
  const app = express();
  app.set("trust proxy", 1); // Cloudflare Tunnel terminates SSL

  if (config.IS_APIFY) {
    // Apify Standby: PPE handles billing, no x402 needed
    console.error("[scout-mcp] Apify mode — skipping x402 initialization");
    app.use((req: Request, _res: Response, next) => {
      (req as any)._channel = "apify";
      next();
    });
  } else {
    // --- Facilitator client ---
    // Use @coinbase/x402 official helper for CDP facilitator auth.
    // Falls back to env-configured URL if CDP keys are not set.
    const facilitatorConfig =
      config.CDP_API_KEY_ID && config.CDP_API_KEY_SECRET
        ? createFacilitatorConfig(config.CDP_API_KEY_ID, config.CDP_API_KEY_SECRET)
        : { url: config.FACILITATOR_URL };

    console.error(
      `[scout-mcp] Facilitator: ${(facilitatorConfig as { url?: string }).url ?? "CDP default"}` +
        (config.CDP_API_KEY_ID ? " (CDP @coinbase/x402 auth)" : " (no auth)"),
    );

    const network = config.NETWORK as Network;
    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    const resourceServer = new x402ResourceServer(facilitatorClient);
    resourceServer.register(network, new ExactEvmScheme());
    resourceServer.registerExtension(bazaarResourceServerExtension);

    // --- Payment options (env-configurable via config.ts) ---
    const PRICE_LOW = config.PRICE_LOW;
    const PRICE_X = config.PRICE_X;
    const PRICE_XFULL = config.PRICE_XFULL;

    const makeOption = (price: string) => ({
      scheme: "exact" as const,
      payTo: config.EVM_ADDRESS,
      price,
      network,
    });

    const makeRoute = (
      description: string,
      price: string,
      bazaarInfo?: Record<string, unknown>,
    ) => ({
      accepts: [makeOption(price)],
      description,
      mimeType: "application/json",
      ...(bazaarInfo ? { extensions: { bazaar: { info: bazaarInfo } } } : {}),
    });

    // --- Route configs (x402 payment-protected) ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes: Record<string, any> = {
      "GET /scout/hn": makeRoute(
        "Search Hacker News for tech news, startup funding, and developer discussions. AI agent API for market research and trend analysis",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "AI agents" } }, output: { type: "json" } },
      ),
      "GET /scout/npm": makeRoute(
        "Search npm package registry — find JavaScript and TypeScript libraries, frameworks, and developer tools. AI agent API for dependency research",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "mcp server" } }, output: { type: "json" } },
      ),
      "GET /scout/github": makeRoute(
        "Search GitHub repositories — discover open source projects, developer tools, and trending repos. AI agent API for competitive intelligence",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "AI agent framework" } }, output: { type: "json" } },
      ),
      "GET /scout/github/repo": makeRoute(
        "Get GitHub repository details — stars, forks, contributors, releases, and license info. AI agent API for open source intelligence",
        PRICE_LOW,
        {
          input: { type: "http", queryParams: { owner: "coinbase", repo: "x402" } },
          output: { type: "json" },
        },
      ),
      "GET /scout/pypi": makeRoute(
        "Search PyPI for Python packages — find libraries, frameworks, and developer tools. AI agent API for Python ecosystem research",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "fastapi" } }, output: { type: "json" } },
      ),
      "GET /scout/ph": makeRoute(
        "Search Product Hunt for new products, SaaS launches, and developer tools. AI agent API for market research and competitive intelligence",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "developer-tools" } }, output: { type: "json" } },
      ),
      "GET /scout/x": makeRoute(
        "Search X (Twitter) for real-time posts, trends, and discussions via xAI Grok. AI agent API for social media intelligence and sentiment analysis",
        PRICE_X,
        {
          input: { type: "http", queryParams: { q: "AI startups" } },
          output: { type: "json" },
        },
      ),
      "GET /scout/x402": makeRoute(
        "Search x402 Bazaar for AI agent APIs with micropayment access. Discover x402-enabled services and developer tools",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "search API" } }, output: { type: "json" } },
      ),
      "GET /scout/report": makeRoute(
        "Multi-source intelligence report — search 14 sources in parallel (HN, GitHub, npm, PyPI, Dev.to, Hashnode, Lobsters, StackExchange, ArXiv, Semantic Scholar, Lemmy, GitLab). AI agent API for comprehensive market research",
        PRICE_LOW,
        {
          input: { type: "http", queryParams: { q: "MCP servers" } },
          output: { type: "json" },
        },
      ),
      "GET /scout/report/full": makeRoute(
        "Comprehensive intelligence report — search all 18 sources in parallel including X/Twitter, Product Hunt, Reddit, YouTube. AI agent API for full market research and competitive analysis",
        PRICE_XFULL,
        { input: { type: "http", queryParams: { q: "AI agents" } }, output: { type: "json" } },
      ),
      "GET /scout/devto": makeRoute(
        "Search Dev.to for developer articles, tutorials, and technical blog posts. AI agent API for developer content and trend research",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "typescript" } }, output: { type: "json" } },
      ),
      "GET /scout/hashnode": makeRoute(
        "Search Hashnode for technical blog posts, tutorials, and developer insights. AI agent API for content research and trend monitoring",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "react" } }, output: { type: "json" } },
      ),
      "GET /scout/lobsters": makeRoute(
        "Search Lobste.rs for curated tech news and developer discussions. AI agent API for trend monitoring and community sentiment",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "rust" } }, output: { type: "json" } },
      ),
      "GET /scout/stackoverflow": makeRoute(
        "Search Stack Overflow for developer Q&A, solutions, and best practices. AI agent API for technical knowledge retrieval",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "async await" } }, output: { type: "json" } },
      ),
      "GET /scout/arxiv": makeRoute(
        "Search ArXiv for academic papers and preprints in AI, machine learning, CS, and mathematics. AI agent API for scientific research",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "transformer attention" } }, output: { type: "json" } },
      ),
      "GET /scout/scholar": makeRoute(
        "Search Semantic Scholar — 200M+ academic papers with citation graph. AI agent API for literature review and research intelligence",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "large language models" } }, output: { type: "json" } },
      ),
      "GET /scout/gitlab": makeRoute(
        "Search GitLab for public projects — enterprise open source and DevOps tools. AI agent API for competitive intelligence",
        PRICE_LOW,
        { input: { type: "http", queryParams: { q: "kubernetes" } }, output: { type: "json" } },
      ),
    };

    // x402 payment middleware + RapidAPI bypass
    const x402Mw = paymentMiddleware(routes, resourceServer);
    app.use((req: Request, res: Response, next) => {
      // RapidAPI proxy: secret header bypass
      const secret = req.headers["x-rapidapi-proxy-secret"];
      if (
        config.RAPIDAPI_PROXY_SECRET &&
        typeof secret === "string" &&
        secret.length > 0 &&
        secret === config.RAPIDAPI_PROXY_SECRET
      ) {
        (req as any)._channel = "rapidapi";
        return next();
      }
      return x402Mw(req, res, next);
    });
  }

  // HEAD guard: prevent health-check bots from triggering API calls.
  // x402 routes only match "GET" verb, so HEAD bypasses payment.
  // Express routes HEAD→GET by default, causing free API execution.
  app.use("/scout", (req: Request, res: Response, next) => {
    if (req.method === "HEAD") return res.sendStatus(402);
    next();
  });

  // Request logger: log all /scout/* requests for audit trail
  app.use("/scout", (req: Request, _res: Response, next) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const ch = (req as any)._channel || "x402";
    console.error(
      `[req] ${req.method} ${req.originalUrl} from=${ip} ch=${ch} ua=${(req.headers["user-agent"] || "").slice(0, 80)}`,
    );
    next();
  });

  // Request counter (runs for all requests including free ones)
  app.use((req: Request, _res: Response, next) => {
    stats.requests_total++;
    const key = `${req.method} ${req.path}`;
    stats.requests_by_endpoint[key] = (stats.requests_by_endpoint[key] || 0) + 1;
    const isFree =
      req.path === "/health" ||
      req.path.startsWith("/.well-known") ||
      req.path === "/openapi.json" ||
      req.path === "/robots.txt" ||
      req.path === "/";
    const ch = (req as any)._channel || (isFree ? "free" : "x402");
    stats.requests_by_channel[ch] = (stats.requests_by_channel[ch] || 0) + 1;
    next();
  });

  // ── Free endpoints ────────────────────────────────────────

  // Root route — required for Apify Standby readiness probe
  app.get("/", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "scout-mcp" });
  });

  app.get("/health", (_req: Request, res: Response) => {
    const uptime = process.uptime();
    const d = Math.floor(uptime / 86400);
    const h = Math.floor((uptime % 86400) / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    const costHealth = getXCostHealth();
    res.json({
      status: "ok",
      service: "scout-mcp",
      channel: config.IS_APIFY ? "apify" : "x402",
      network: config.NETWORK,
      uptime: `${d}d ${h}h ${m}m`,
      stats: {
        requests_total: stats.requests_total,
        requests_by_channel: stats.requests_by_channel,
        x_calls: stats.x_calls,
        x_cost_estimate: `$${stats.x_cost_estimate.toFixed(3)}`,
        errors_total: stats.errors_total,
        top_endpoints: Object.fromEntries(
          Object.entries(stats.requests_by_endpoint)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10),
        ),
      },
      pricing: {
        x_search: config.PRICE_X,
        report_full: config.PRICE_XFULL,
        low: config.PRICE_LOW,
      },
      xai_cost_health: {
        ...costHealth,
        ...(costHealth.alert
          ? { warning: "xAI cost margin below 40%. Check dashboard and consider price adjustment." }
          : {}),
      },
    });
  });

  // Static endpoint list for /.well-known/x402 (no dependency on x402 routes object)
  const SCOUT_PATHS = [
    "/scout/hn", "/scout/npm", "/scout/github", "/scout/github/repo",
    "/scout/pypi", "/scout/ph", "/scout/x", "/scout/x402",
    "/scout/report", "/scout/report/full",
    "/scout/devto", "/scout/hashnode", "/scout/lobsters",
    "/scout/stackoverflow", "/scout/arxiv",
    "/scout/scholar", "/scout/gitlab",
  ];

  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const origin = `${proto}://${req.get("host")}`;
    res.json({
      version: 1,
      resources: SCOUT_PATHS.map((p) => `${origin}${p}`),
      instructions:
        "# Scout MCP \u2014 Multi-source Intelligence API\n\n" +
        "Search across HN, GitHub, npm, PyPI, X, Product Hunt, and x402 Bazaar.\n\n" +
        "## Endpoints\n" +
        "- `GET /scout/hn?q=<query>` \u2014 Hacker News ($0.001)\n" +
        "- `GET /scout/npm?q=<query>` \u2014 npm registry ($0.001)\n" +
        "- `GET /scout/github?q=<query>` \u2014 GitHub repos ($0.001)\n" +
        "- `GET /scout/github/repo?owner=<o>&repo=<r>` \u2014 GitHub repo detail ($0.001)\n" +
        "- `GET /scout/pypi?q=<query>` \u2014 PyPI packages ($0.001)\n" +
        "- `GET /scout/ph?q=<query>` \u2014 Product Hunt ($0.001)\n" +
        "- `GET /scout/x?q=<query>` \u2014 X/Twitter ($0.20)\n" +
        "- `GET /scout/x402?q=<query>` \u2014 x402 Bazaar search ($0.001)\n" +
        "- `GET /scout/scholar?q=<query>` \u2014 Semantic Scholar papers ($0.001)\n" +
        "- `GET /scout/gitlab?q=<query>` \u2014 GitLab projects ($0.001)\n" +
        "- `GET /scout/report?q=<query>` \u2014 Balanced report ($0.001)\n" +
        "- `GET /scout/report/full?q=<query>` \u2014 Full report ($0.25)\n\n" +
        "## Pricing\n" +
        "Free sources: $0.001/request. X search: $0.20/request. Full report: $0.25/request. USDC on Base.\n\n" +
        "## Contact\n" +
        "GitHub: https://github.com/bartonguestier1725-collab/scout-mcp",
    });
  });

  app.get("/openapi.json", (req: Request, res: Response) => {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const origin = `${proto}://${req.get("host")}`;
    res.json({
      openapi: "3.0.3",
      info: {
        title: "Scout MCP — Multi-source Intelligence API",
        description:
          "Search across Hacker News, GitHub, npm, PyPI, X/Twitter, Product Hunt, and x402 Bazaar. " +
          "Paid via x402 micropayments (USDC on Base).",
        version: "1.0.0",
        contact: { url: "https://github.com/bartonguestier1725-collab/scout-mcp" },
      },
      servers: [{ url: origin }],
      paths: {
        "/scout/hn": {
          get: {
            summary: "Search Hacker News",
            description: "Search Hacker News stories, comments, and polls via Algolia. Returns titles, URLs, points, comment counts, and dates. Supports filtering by content type and sorting by relevance or date.",
            operationId: "searchHN",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "AI agents" }, description: "Search query string" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "date"], default: "relevance" }, description: "Sort order: relevance (default) or chronological" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Number of results to return (1-50)" },
              { name: "tag", in: "query", schema: { type: "string", enum: ["story", "comment", "poll", "show_hn", "ask_hn"] }, description: "Filter by content type" },
            ],
            responses: { "200": { description: "Search results with title, URL, points, comments, author, and date" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/npm": {
          get: {
            summary: "Search npm registry",
            description: "Search the npm package registry by name, keywords, or description. Returns package name, version, description, and quality/popularity/maintenance scores.",
            operationId: "searchNpm",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "mcp server" }, description: "Package name, keywords, or description to search" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Number of results to return (1-50)" },
            ],
            responses: { "200": { description: "Search results with package name, version, scores, and links" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/github": {
          get: {
            summary: "Search GitHub repositories",
            description: "Search GitHub repositories by keyword, topic, or description. Returns stars, forks, language, topics, and license info. Supports GitHub search qualifiers like 'topic:mcp'.",
            operationId: "searchGitHub",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "x402" }, description: "Search query (supports GitHub qualifiers like topic:mcp, language:python)" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["stars", "forks", "updated", "best-match"], default: "best-match" }, description: "Sort order for results" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Number of results to return (1-50)" },
              { name: "language", in: "query", schema: { type: "string", example: "typescript" }, description: "Filter by programming language" },
            ],
            responses: { "200": { description: "Search results with repo name, stars, forks, language, topics, and license" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/github/repo": {
          get: {
            summary: "Get GitHub repository details",
            description: "Get detailed information about a specific GitHub repository including stars, forks, contributors, releases, license, topics, and more. Optionally include top 10 contributors and 5 most recent releases.",
            operationId: "getGitHubRepo",
            parameters: [
              { name: "owner", in: "query", required: true, schema: { type: "string", example: "coinbase" }, description: "Repository owner (username or organization)" },
              { name: "repo", in: "query", required: true, schema: { type: "string", example: "x402" }, description: "Repository name" },
              { name: "include_contributors", in: "query", schema: { type: "boolean", default: false }, description: "Include top 10 contributors" },
              { name: "include_releases", in: "query", schema: { type: "boolean", default: false }, description: "Include 5 most recent releases" },
            ],
            responses: { "200": { description: "Repository details with stars, forks, language, topics, license, contributors, and releases" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/pypi": {
          get: {
            summary: "Search PyPI packages",
            description: "Look up Python packages on PyPI by name. Tries multiple name variants (hyphenated, underscored, with py- prefix). Returns version, summary, license, and links.",
            operationId: "searchPyPI",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "fastapi" }, description: "Package name or approximate name to look up" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 }, description: "Number of results to return (1-20)" },
            ],
            responses: { "200": { description: "Search results with package name, version, summary, license, and links" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/ph": {
          get: {
            summary: "Search Product Hunt",
            description: "Search Product Hunt for products and launches. Returns product name, tagline, votes, comments, topics, and makers. Sorted by votes or newest.",
            operationId: "searchProductHunt",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "developer-tools" }, description: "Topic slug or keywords to search" },
              { name: "order", in: "query", schema: { type: "string", enum: ["VOTES", "NEWEST"], default: "VOTES" }, description: "Sort by most votes or newest" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "Number of results to return (1-20)" },
            ],
            responses: { "200": { description: "Search results with product name, tagline, votes, comments, topics, and makers" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/x": {
          get: {
            summary: "Search X/Twitter via xAI Grok",
            description: "Search X (Twitter) for posts, discussions, and trends using xAI's Grok API with web search. Returns author, text, URL, and date. Premium endpoint due to upstream xAI API cost (~$0.05/call).",
            operationId: "searchX",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "x402 protocol" }, description: "Search query for X/Twitter" },
              { name: "recency", in: "query", schema: { type: "string", enum: ["day", "week", "month"], default: "week" }, description: "Time filter for results" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "Number of results to return (1-20)" },
            ],
            responses: { "200": { description: "Search results with author, text, URL, date, and cost estimate" }, "402": { description: "Payment required ($0.20)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/x402": {
          get: {
            summary: "Search x402 Bazaar",
            description: "Search the x402 Bazaar for AI-agent APIs with micropayment access. Queries the CDP Discovery directory of x402-enabled HTTP resources. Returns matching APIs with price, network, and relevance score.",
            operationId: "searchBazaar",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "weather" }, description: "Search query (matched against API URL and description)" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Number of results to return (1-50)" },
            ],
            responses: { "200": { description: "Search results with API URL, description, price, network, and relevance score" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/report": {
          get: {
            summary: "Balanced intelligence report (14 free sources)",
            description: "Run a multi-source intelligence report across 14 free sources in parallel: Hacker News, GitHub, npm, PyPI, Dev.to, Hashnode, Lobsters, StackExchange, ArXiv, Zenn, Qiita, Semantic Scholar, Lemmy, and GitLab. Returns aggregated results from all sources in a single response.",
            operationId: "balancedReport",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "MCP servers" }, description: "Search query to scout across sources" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 }, description: "Results per source (1-20)" },
            ],
            responses: { "200": { description: "Multi-source report with results from each source and summary statistics" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/report/full": {
          get: {
            summary: "Comprehensive report (all 18 sources including X)",
            description: "Run a comprehensive intelligence report across all 18 sources in parallel: Hacker News, GitHub, npm, PyPI, X/Twitter, Product Hunt, Dev.to, Hashnode, Lobsters, StackExchange, ArXiv, Reddit, YouTube, Zenn, Qiita, Semantic Scholar, Lemmy, and GitLab. Premium endpoint because it includes X/Twitter search (~$0.05 upstream cost).",
            operationId: "fullReport",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "AI agents" }, description: "Search query to scout across all sources" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 }, description: "Results per source (1-20)" },
            ],
            responses: { "200": { description: "Comprehensive multi-source report with results from all 13 sources" }, "402": { description: "Payment required ($0.25)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/devto": {
          get: {
            summary: "Search Dev.to articles",
            description: "Search Dev.to (Forem) for technical articles and blog posts. Returns title, description, reactions, comments, reading time, and tags.",
            operationId: "searchDevto",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "typescript" }, description: "Search query" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 30, default: 10 }, description: "Results per page" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "latest", "top"], default: "relevance" }, description: "Sort order" },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/hashnode": {
          get: {
            summary: "Search Hashnode posts",
            description: "Search Hashnode for technical blog posts via GraphQL API. Returns title, brief, reactions, reading time, and tags.",
            operationId: "searchHashnode",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "react" }, description: "Search query" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "Results per page" },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/lobsters": {
          get: {
            summary: "Search Lobste.rs",
            description: "Search Lobste.rs for curated tech news. A community-driven link aggregator similar to HN but more tightly curated.",
            operationId: "searchLobsters",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "rust" }, description: "Search query" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 25, default: 10 }, description: "Results per page" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["hot", "newest"], default: "hot" }, description: "Sort order" },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/stackoverflow": {
          get: {
            summary: "Search Stack Overflow",
            description: "Search Stack Overflow and other StackExchange sites for Q&A. Returns questions with score, answers, views, and tags.",
            operationId: "searchStackOverflow",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "async await" }, description: "Search query" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Results per page" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "votes", "activity", "creation"], default: "relevance" }, description: "Sort order" },
              { name: "site", in: "query", schema: { type: "string", default: "stackoverflow" }, description: "StackExchange site" },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/arxiv": {
          get: {
            summary: "Search ArXiv papers",
            description: "Search ArXiv for academic papers and preprints. Returns title, authors, abstract, PDF link, and categories.",
            operationId: "searchArxiv",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "transformer attention" }, description: "Search query" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Results per page" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "date"], default: "relevance" }, description: "Sort order" },
              { name: "category", in: "query", schema: { type: "string", example: "cs.AI" }, description: "ArXiv category filter" },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/scholar": {
          get: {
            summary: "Search Semantic Scholar papers",
            description: "Search Semantic Scholar for academic papers across all disciplines (200M+ papers). Returns title, abstract, citations, influential citations, authors, journal, open access PDF link, and fields of study. Superior to ArXiv alone because it covers all fields and includes citation graph data.",
            operationId: "searchSemanticScholar",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "large language models" }, description: "Search query for papers" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "Results per page" },
              { name: "year", in: "query", schema: { type: "string", example: "2024" }, description: "Filter by year or range (e.g. '2024', '2020-2024')" },
              { name: "fields_of_study", in: "query", schema: { type: "string", example: "Computer Science" }, description: "Filter by field" },
            ],
            responses: { "200": { description: "Search results with paper title, abstract, citations, authors, and PDF links" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
        "/scout/gitlab": {
          get: {
            summary: "Search GitLab projects",
            description: "Search GitLab.com for public projects. Returns name, description, stars, forks, topics, and last activity date. Covers enterprise OSS and projects not hosted on GitHub.",
            operationId: "searchGitLab",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string", example: "kubernetes" }, description: "Search query for GitLab projects" },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "Results per page" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["stars", "updated", "name"], default: "stars" }, description: "Sort order" },
            ],
            responses: { "200": { description: "Search results with project name, stars, forks, topics, and activity" }, "402": { description: "Payment required ($0.001)" }, "502": { description: "Upstream source error" } },
          },
        },
      },
    });
  });

  // ── Paid endpoints ────────────────────────────────────────

  app.get("/scout/hn", async (req: Request, res: Response) => {
    try {
      const result = await hnSearch({
        query: q(req),
        sort: (req.query.sort as "relevance" | "date") || undefined,
        per_page: perPage(req),
        tag: (req.query.tag as string) || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/npm", async (req: Request, res: Response) => {
    try {
      const result = await npmSearch({ query: q(req), per_page: perPage(req) });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/github", async (req: Request, res: Response) => {
    try {
      const result = await githubSearch({
        query: q(req),
        sort: (req.query.sort as "stars" | "forks" | "updated" | "best-match") || undefined,
        per_page: perPage(req),
        language: (req.query.language as string) || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/github/repo", async (req: Request, res: Response) => {
    try {
      const owner = String(req.query.owner || "");
      const repo = String(req.query.repo || "");
      if (!owner || !repo) {
        res.status(400).json({ error: "owner and repo query params required" });
        return;
      }
      const result = await githubRepoInfo({
        owner,
        repo,
        include_contributors: req.query.include_contributors === "true",
        include_releases: req.query.include_releases === "true",
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/pypi", async (req: Request, res: Response) => {
    try {
      const result = await pypiSearch({ query: q(req), per_page: perPage(req) });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/ph", async (req: Request, res: Response) => {
    try {
      const result = await phSearch({
        query: q(req),
        order: (req.query.order as "VOTES" | "NEWEST") || undefined,
        per_page: perPage(req),
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/x", async (req: Request, res: Response) => {
    try {
      // RapidAPI X rate limit check
      const xBlock = checkRapidApiXLimit(req);
      if (xBlock) return res.status(xBlock.status).json(xBlock.body);

      stats.x_calls++;
      const result = await xSearch({
        query: q(req),
        recency: (req.query.recency as "day" | "week" | "month") || undefined,
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
      trackXCost(result);
      if (result.success && !(await apifyCharge("search-x"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/x402", async (req: Request, res: Response) => {
    try {
      const result = await bazaarSearch({ query: q(req), per_page: perPage(req) });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/report", async (req: Request, res: Response) => {
    try {
      const result = await scoutReport({
        query: q(req),
        focus: "balanced",
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
      if (result.success && !(await apifyCharge("report-balanced"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/report/full", async (req: Request, res: Response) => {
    try {
      // RapidAPI X rate limit check (full report includes X search)
      const xBlock = checkRapidApiXLimit(req);
      if (xBlock) return res.status(xBlock.status).json(xBlock.body);

      stats.x_calls++;
      const result = await scoutReport({
        query: q(req),
        focus: "comprehensive",
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
      // scout_report wraps x results — extract cost from nested data if available
      trackXCostFromReport(result);
      if (result.success && !(await apifyCharge("report-full"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ── New source endpoints (Phase 2) ───────────────────────

  app.get("/scout/devto", async (req: Request, res: Response) => {
    try {
      const result = await devtoSearch({
        query: q(req),
        per_page: perPage(req),
        sort: (req.query.sort as "relevance" | "latest" | "top") || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/hashnode", async (req: Request, res: Response) => {
    try {
      const result = await hashnodeSearch({
        query: q(req),
        per_page: perPage(req),
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/lobsters", async (req: Request, res: Response) => {
    try {
      const result = await lobstersSearch({
        query: q(req),
        per_page: perPage(req),
        sort: (req.query.sort as "hot" | "newest") || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/stackoverflow", async (req: Request, res: Response) => {
    try {
      const result = await stackexchangeSearch({
        query: q(req),
        per_page: perPage(req),
        sort: (req.query.sort as "relevance" | "votes" | "activity" | "creation") || undefined,
        site: (req.query.site as string) || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/arxiv", async (req: Request, res: Response) => {
    try {
      const result = await arxivSearch({
        query: q(req),
        per_page: perPage(req),
        sort: (req.query.sort as "relevance" | "date") || undefined,
        category: (req.query.category as string) || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/scholar", async (req: Request, res: Response) => {
    try {
      const result = await semanticScholarSearch({
        query: q(req),
        per_page: perPage(req),
        year: (req.query.year as string) || undefined,
        fields_of_study: (req.query.fields_of_study as string) || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/gitlab", async (req: Request, res: Response) => {
    try {
      const result = await gitlabSearch({
        query: q(req),
        per_page: perPage(req),
        sort: (req.query.sort as "stars" | "updated" | "name") || undefined,
      });
      if (result.success && !(await apifyCharge("search-free"))) {
        return res.status(402).json({ error: "Apify charge limit reached" });
      }
      sendResult(res, result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // --- Start ---
  app.listen(config.X402_PORT, () => {
    console.error(`[scout-mcp] HTTP server listening on port ${config.X402_PORT}`);
    console.error(`[scout-mcp] Network: ${config.NETWORK}`);
    console.error(`[scout-mcp] EVM address: ${config.EVM_ADDRESS}`);
    console.error(`[scout-mcp] Endpoints: ${SCOUT_PATHS.length} routes`);
  });
}

// ── Graceful shutdown ──────────────────────────────────────

process.on("SIGTERM", () => {
  console.error("[scout-mcp] SIGTERM received, shutting down");
  if (Actor) {
    Actor.exit();
  } else {
    process.exit(0);
  }
});

// ── Apify batch run (non-Standby) ─────────────────────────
// Apify QA tests run the Actor as a normal run with prefilled input.
// Detect this and execute batch → pushData → exit instead of starting HTTP server.

if (config.IS_APIFY && process.env.APIFY_META_ORIGIN !== "STANDBY") {
  console.error(
    `[scout-mcp] Batch run mode (origin=${process.env.APIFY_META_ORIGIN})`,
  );

  const input = (await Actor.getInput()) as {
    query?: string;
    source?: string;
    per_page?: number;
  } | null;

  const query = input?.query || "AI agents";
  const source = input?.source || "hn";
  const per_page = input?.per_page || 10;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sourceMap: Record<string, (a: any) => Promise<any>> = {
    hn: (a) => hnSearch({ query: a.query, per_page: a.per_page }),
    npm: (a) => npmSearch({ query: a.query, per_page: a.per_page }),
    github: (a) => githubSearch({ query: a.query, per_page: a.per_page }),
    pypi: (a) => pypiSearch({ query: a.query, per_page: a.per_page }),
    ph: (a) => phSearch({ query: a.query, per_page: a.per_page }),
    x: (a) => xSearch({ query: a.query, per_page: a.per_page }),
    x402: (a) => bazaarSearch({ query: a.query, per_page: a.per_page }),
    report: (a) =>
      scoutReport({ query: a.query, focus: "balanced", per_page: a.per_page }),
    "report-full": (a) =>
      scoutReport({
        query: a.query,
        focus: "comprehensive",
        per_page: a.per_page,
      }),
    // Phase 2 sources
    devto: (a) => devtoSearch({ query: a.query, per_page: a.per_page }),
    hashnode: (a) => hashnodeSearch({ query: a.query, per_page: a.per_page }),
    lobsters: (a) => lobstersSearch({ query: a.query, per_page: a.per_page }),
    stackoverflow: (a) =>
      stackexchangeSearch({ query: a.query, per_page: a.per_page }),
    arxiv: (a) => arxivSearch({ query: a.query, per_page: a.per_page }),
    scholar: (a) =>
      semanticScholarSearch({ query: a.query, per_page: a.per_page }),
    gitlab: (a) => gitlabSearch({ query: a.query, per_page: a.per_page }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const searchFn = sourceMap[source] || sourceMap.hn;
  console.error(
    `[scout-mcp] Executing: source=${source} query="${query}" per_page=${per_page}`,
  );

  const result = await searchFn({ query, per_page });
  await Actor.pushData(result);

  console.error("[scout-mcp] Batch run complete, exiting");
  await Actor.exit();
  process.exit(0);
}

// ── Standby mode or local — start HTTP server ────────────

startServer().catch((err) => {
  console.error("[scout-mcp] Fatal:", err);
  process.exit(1);
});
