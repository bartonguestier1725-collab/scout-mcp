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

// ── Stats (in-memory, resets on restart) ────────────────────

const stats = {
  started_at: new Date().toISOString(),
  requests_total: 0,
  requests_by_endpoint: {} as Record<string, number>,
  requests_by_channel: { x402: 0, rapidapi: 0, free: 0 } as Record<string, number>,
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

// ── Main ────────────────────────────────────────────────────

async function startServer() {
  if (!config.EVM_ADDRESS) {
    throw new Error(
      "EVM_ADDRESS not set. Configure .env before starting the HTTP server.",
    );
  }

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
      "Search Hacker News stories, comments, and polls via Algolia",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "x402" } }, output: { type: "json" } },
    ),
    "GET /scout/npm": makeRoute(
      "Search the npm package registry by name, keywords, or description",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "mcp" } }, output: { type: "json" } },
    ),
    "GET /scout/github": makeRoute(
      "Search GitHub repositories by keyword, topic, or description",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "x402" } }, output: { type: "json" } },
    ),
    "GET /scout/github/repo": makeRoute(
      "Get detailed info about a specific GitHub repository",
      PRICE_LOW,
      {
        input: { type: "http", queryParams: { owner: "coinbase", repo: "x402" } },
        output: { type: "json" },
      },
    ),
    "GET /scout/pypi": makeRoute(
      "Look up Python packages on PyPI by name",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "fastapi" } }, output: { type: "json" } },
    ),
    "GET /scout/ph": makeRoute(
      "Search Product Hunt for products and launches",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "ai-agents" } }, output: { type: "json" } },
    ),
    "GET /scout/x": makeRoute(
      "Search X/Twitter via xAI Grok with web search (~$0.05 upstream cost)",
      PRICE_X,
      {
        input: { type: "http", queryParams: { q: "x402 protocol" } },
        output: { type: "json" },
      },
    ),
    "GET /scout/x402": makeRoute(
      "Search x402 Bazaar for AI-agent APIs with micropayment access",
      PRICE_LOW,
      { input: { type: "http", queryParams: { q: "weather" } }, output: { type: "json" } },
    ),
    "GET /scout/report": makeRoute(
      "Multi-source intelligence report (free sources: HN, GitHub, npm, PyPI)",
      PRICE_LOW,
      {
        input: { type: "http", queryParams: { q: "MCP servers" } },
        output: { type: "json" },
      },
    ),
    "GET /scout/report/full": makeRoute(
      "Comprehensive intelligence report across all 6 sources including X and Product Hunt",
      PRICE_XFULL,
      { input: { type: "http", queryParams: { q: "AI agents" } }, output: { type: "json" } },
    ),
  };

  // --- Express app ---
  const app = express();
  app.set("trust proxy", 1); // Cloudflare Tunnel terminates SSL

  // x402 payment middleware + RapidAPI bypass
  const x402Mw = paymentMiddleware(routes, resourceServer);
  app.use((req: Request, res: Response, next) => {
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

  app.get("/health", (_req: Request, res: Response) => {
    const uptime = process.uptime();
    const d = Math.floor(uptime / 86400);
    const h = Math.floor((uptime % 86400) / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    const costHealth = getXCostHealth();
    res.json({
      status: "ok",
      service: "scout-mcp",
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

  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const origin = `${proto}://${req.get("host")}`;
    res.json({
      version: 1,
      resources: Object.keys(routes).map((r) => {
        const path = r.split(" ")[1];
        return `${origin}${path}`;
      }),
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
            operationId: "searchHN",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query" },
              { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "date"] } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
              { name: "tag", in: "query", schema: { type: "string", enum: ["story", "comment", "poll", "show_hn", "ask_hn"] } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/npm": {
          get: {
            summary: "Search npm registry",
            operationId: "searchNpm",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/github": {
          get: {
            summary: "Search GitHub repositories",
            operationId: "searchGitHub",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "sort", in: "query", schema: { type: "string", enum: ["stars", "forks", "updated", "best-match"] } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
              { name: "language", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/github/repo": {
          get: {
            summary: "Get GitHub repository details",
            operationId: "getGitHubRepo",
            parameters: [
              { name: "owner", in: "query", required: true, schema: { type: "string" } },
              { name: "repo", in: "query", required: true, schema: { type: "string" } },
              { name: "include_contributors", in: "query", schema: { type: "boolean" } },
              { name: "include_releases", in: "query", schema: { type: "boolean" } },
            ],
            responses: { "200": { description: "Repository details" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/pypi": {
          get: {
            summary: "Search PyPI packages",
            operationId: "searchPyPI",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/ph": {
          get: {
            summary: "Search Product Hunt",
            operationId: "searchProductHunt",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "order", in: "query", schema: { type: "string", enum: ["VOTES", "NEWEST"] } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/x": {
          get: {
            summary: "Search X/Twitter via xAI Grok",
            operationId: "searchX",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "recency", in: "query", schema: { type: "string", enum: ["day", "week", "month"] } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.20)" } },
          },
        },
        "/scout/x402": {
          get: {
            summary: "Search x402 Bazaar",
            operationId: "searchBazaar",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
            ],
            responses: { "200": { description: "Search results" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/report": {
          get: {
            summary: "Balanced intelligence report (HN, GitHub, npm, PyPI)",
            operationId: "balancedReport",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
            ],
            responses: { "200": { description: "Multi-source report" }, "402": { description: "Payment required ($0.001)" } },
          },
        },
        "/scout/report/full": {
          get: {
            summary: "Comprehensive report (all 6 sources including X)",
            operationId: "fullReport",
            parameters: [
              { name: "q", in: "query", required: true, schema: { type: "string" } },
              { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } },
            ],
            responses: { "200": { description: "Multi-source report" }, "402": { description: "Payment required ($0.25)" } },
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
      res.json(result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/npm", async (req: Request, res: Response) => {
    try {
      res.json(await npmSearch({ query: q(req), per_page: perPage(req) }));
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
      res.json(result);
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
      res.json(result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/pypi", async (req: Request, res: Response) => {
    try {
      res.json(await pypiSearch({ query: q(req), per_page: perPage(req) }));
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
      res.json(result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/x", async (req: Request, res: Response) => {
    try {
      stats.x_calls++;
      const result = await xSearch({
        query: q(req),
        recency: (req.query.recency as "day" | "week" | "month") || undefined,
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
      trackXCost(result);
      res.json(result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/x402", async (req: Request, res: Response) => {
    try {
      res.json(await bazaarSearch({ query: q(req), per_page: perPage(req) }));
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
      res.json(result);
    } catch (err) {
      stats.errors_total++;
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  app.get("/scout/report/full", async (req: Request, res: Response) => {
    try {
      stats.x_calls++;
      const result = await scoutReport({
        query: q(req),
        focus: "comprehensive",
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
      // scout_report wraps x results — extract cost from nested data if available
      trackXCostFromReport(result);
      res.json(result);
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
    console.error(`[scout-mcp] Endpoints: ${Object.keys(routes).length} paid routes`);
  });
}

startServer().catch((err) => {
  console.error("[scout-mcp] Fatal:", err);
  process.exit(1);
});
