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
  type FacilitatorConfig,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions";
import { SignJWT, importPKCS8, importJWK } from "jose";
import { randomBytes } from "node:crypto";

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
  errors_total: 0,
  x_calls: 0,
  x_cost_estimate: 0,
};

// ── CDP JWT Auth ────────────────────────────────────────────

/**
 * Generate a CDP-compatible JWT for facilitator API authentication.
 * Supports both ES256 (PEM) and EdDSA (Ed25519 base64) key formats.
 */
async function generateCDPJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  path: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");

  const claims = {
    sub: apiKeyId,
    iss: "cdp",
    uris: [`${method} api.cdp.coinbase.com${path}`],
  };

  // Try ES256 (PEM) first
  try {
    const ecKey = await importPKCS8(apiKeySecret, "ES256");
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: apiKeyId, typ: "JWT", nonce })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 120)
      .sign(ecKey);
  } catch {
    // Fall through to Ed25519
  }

  // Ed25519 (base64-encoded 64 bytes: 32 seed + 32 public)
  const decoded = Buffer.from(apiKeySecret, "base64");
  if (decoded.length !== 64) {
    throw new Error(
      `Invalid CDP key: expected 64 bytes (Ed25519), got ${decoded.length}`,
    );
  }
  const jwk = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    d: decoded.subarray(0, 32).toString("base64url"),
    x: decoded.subarray(32).toString("base64url"),
  };
  const key = await importJWK(jwk, "EdDSA");
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: apiKeyId, typ: "JWT", nonce })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(key);
}

/**
 * Build createAuthHeaders function for HTTPFacilitatorClient.
 * Called on every payment verify/settle/supported request — JWTs are always fresh.
 */
function buildCDPCreateAuthHeaders(apiKeyId: string, apiKeySecret: string) {
  return async () => {
    const [verify, settle, supported] = await Promise.all([
      generateCDPJwt(apiKeyId, apiKeySecret, "POST", "/platform/v2/x402/verify"),
      generateCDPJwt(apiKeyId, apiKeySecret, "POST", "/platform/v2/x402/settle"),
      generateCDPJwt(apiKeyId, apiKeySecret, "GET", "/platform/v2/x402/supported"),
    ]);
    return {
      verify: { Authorization: `Bearer ${verify}` },
      settle: { Authorization: `Bearer ${settle}` },
      supported: { Authorization: `Bearer ${supported}` },
    };
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
  const facilitatorConfig: FacilitatorConfig =
    config.CDP_API_KEY_ID && config.CDP_API_KEY_SECRET
      ? {
          url: config.FACILITATOR_URL,
          createAuthHeaders: buildCDPCreateAuthHeaders(
            config.CDP_API_KEY_ID,
            config.CDP_API_KEY_SECRET,
          ),
        }
      : { url: config.FACILITATOR_URL };

  console.error(
    `[scout-mcp] Facilitator: ${config.FACILITATOR_URL}` +
      (config.CDP_API_KEY_ID ? " (CDP JWT auth)" : " (no auth)"),
  );

  const network = config.NETWORK as Network;
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(network, new ExactEvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension);

  // --- Payment options ---
  const PRICE_LOW = "$0.001";
  const PRICE_HIGH = "$0.05";

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
      "Search X/Twitter via xAI Grok with web search (~$0.005 upstream cost)",
      PRICE_HIGH,
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
      PRICE_HIGH,
      { input: { type: "http", queryParams: { q: "AI agents" } }, output: { type: "json" } },
    ),
  };

  // --- Express app ---
  const app = express();
  app.set("trust proxy", 1); // Cloudflare Tunnel terminates SSL

  // x402 payment middleware (must be before route handlers)
  app.use(paymentMiddleware(routes, resourceServer));

  // Request counter (runs for all requests including free ones)
  app.use((req: Request, _res: Response, next) => {
    stats.requests_total++;
    const key = `${req.method} ${req.path}`;
    stats.requests_by_endpoint[key] = (stats.requests_by_endpoint[key] || 0) + 1;
    next();
  });

  // ── Free endpoints ────────────────────────────────────────

  app.get("/health", (_req: Request, res: Response) => {
    const uptime = process.uptime();
    const d = Math.floor(uptime / 86400);
    const h = Math.floor((uptime % 86400) / 3600);
    const m = Math.floor((uptime % 3600) / 60);

    res.json({
      status: "ok",
      service: "scout-mcp",
      network: config.NETWORK,
      uptime: `${d}d ${h}h ${m}m`,
      stats: {
        requests_total: stats.requests_total,
        x_calls: stats.x_calls,
        x_cost_estimate: `$${stats.x_cost_estimate.toFixed(3)}`,
        errors_total: stats.errors_total,
        top_endpoints: Object.fromEntries(
          Object.entries(stats.requests_by_endpoint)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10),
        ),
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
        "- `GET /scout/x?q=<query>` \u2014 X/Twitter ($0.05)\n" +
        "- `GET /scout/x402?q=<query>` \u2014 x402 Bazaar search ($0.001)\n" +
        "- `GET /scout/report?q=<query>` \u2014 Balanced report ($0.001)\n" +
        "- `GET /scout/report/full?q=<query>` \u2014 Full report ($0.05)\n\n" +
        "## Pricing\n" +
        "Free sources: $0.001/request. X-inclusive: $0.05/request. USDC on Base.\n\n" +
        "## Contact\n" +
        "GitHub: https://github.com/bartonguestier1725-collab/scout-mcp",
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
      stats.x_cost_estimate += 0.005;
      const result = await xSearch({
        query: q(req),
        recency: (req.query.recency as "day" | "week" | "month") || undefined,
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
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
      stats.x_cost_estimate += 0.005;
      const result = await scoutReport({
        query: q(req),
        focus: "comprehensive",
        per_page: perPage(req, MAX_PER_PAGE_COSTLY),
      });
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
