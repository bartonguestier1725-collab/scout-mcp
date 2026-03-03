/**
 * Research route handlers – AI-synthesized intelligence reports
 *
 * POST /scout/research      → balanced (14 sources) + Gemini synthesis ($0.25)
 * POST /scout/research/deep → comprehensive (18 sources) + Gemini synthesis ($0.50)
 */

import type { Request, Response } from "express";
import { execute as scoutReport } from "../tools/scout-report.js";
import {
  synthesize,
  MODEL as GEMINI_MODEL,
  type ResearchFocus,
} from "../tools/gemini-synthesizer.js";

/** Strip credential-like patterns from error messages (same as server.ts) */
const sanitizeError = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/(?:key|token|secret|password|authorization)[=: ]\S+/gi, "[REDACTED]");
};

const MAX_QUERY_LENGTH = 500;
const MAX_PER_PAGE = 20;
const VALID_FOCUS = ["technical", "market", "sentiment"] as const;

interface ResearchBody {
  query?: string;
  per_page?: number;
  focus?: string;
}

function parseBody(req: Request): {
  ok: true;
  query: string;
  per_page: number;
  focus: ResearchFocus;
} | {
  ok: false;
  error: string;
} {
  const body = (req.body ?? {}) as ResearchBody;
  const query = typeof body.query === "string" ? body.query.trim() : "";

  if (!query) {
    return { ok: false, error: "query is required in JSON body" };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      error: `query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`,
    };
  }

  let per_page = 5;
  if (body.per_page !== undefined) {
    const n = Number(body.per_page);
    if (!Number.isFinite(n) || n < 1 || n > MAX_PER_PAGE) {
      return { ok: false, error: `per_page must be 1-${MAX_PER_PAGE}` };
    }
    per_page = Math.round(n);
  }

  let focus: ResearchFocus = "technical";
  if (body.focus !== undefined) {
    if (!VALID_FOCUS.includes(body.focus as ResearchFocus)) {
      return {
        ok: false,
        error: `focus must be one of: ${VALID_FOCUS.join(", ")}`,
      };
    }
    focus = body.focus as ResearchFocus;
  }

  return { ok: true, query, per_page, focus };
}

/**
 * Handle POST /scout/research (balanced, 14 sources)
 */
export async function handleResearch(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = parseBody(req);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const start = Date.now();
  const { query, per_page, focus } = parsed;

  try {
    // Step 1: Multi-source search (balanced = 14 free sources)
    const reportResult = await scoutReport({
      query,
      focus: "balanced",
      per_page,
    });

    // All sources failed → 502 (no x402 charge)
    if (!reportResult.success) {
      res.status(502).json({
        error: "All sources failed",
        detail: reportResult.error,
      });
      return;
    }

    // Check if any source returned data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = (reportResult.data as any)?.summary;
    if (summary?.sources_succeeded === 0) {
      res.status(502).json({
        error: "No sources returned data",
        query,
      });
      return;
    }

    // Step 2: AI synthesis (Gemini failure → 200 + synthesis: null)
    const synthesis = await synthesize(query, reportResult.data, focus);

    const processingTime = Date.now() - start;

    res.status(200).json({
      query,
      depth: "balanced",
      synthesis,
      raw_results: reportResult.data,
      meta: {
        model: synthesis ? GEMINI_MODEL : null,
        sources_queried: 14,
        sources_responded: summary?.sources_succeeded ?? 0,
        processing_time_ms: processingTime,
      },
    });
  } catch (err) {
    console.error("[research] Unexpected error:", err);
    res.status(500).json({
      error: sanitizeError(err),
    });
  }
}

/**
 * Handle POST /scout/research/deep (comprehensive, 18 sources including X)
 */
export async function handleResearchDeep(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = parseBody(req);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const start = Date.now();
  const { query, per_page, focus } = parsed;

  try {
    // Step 1: Multi-source search (comprehensive = all 18 sources)
    const reportResult = await scoutReport({
      query,
      focus: "comprehensive",
      per_page,
    });

    if (!reportResult.success) {
      res.status(502).json({
        error: "All sources failed",
        detail: reportResult.error,
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = (reportResult.data as any)?.summary;
    if (summary?.sources_succeeded === 0) {
      res.status(502).json({
        error: "No sources returned data",
        query,
      });
      return;
    }

    // Step 2: AI synthesis
    const synthesis = await synthesize(query, reportResult.data, focus);

    const processingTime = Date.now() - start;

    res.status(200).json({
      query,
      depth: "comprehensive",
      synthesis,
      raw_results: reportResult.data,
      meta: {
        model: synthesis ? GEMINI_MODEL : null,
        sources_queried: 18,
        sources_responded: summary?.sources_succeeded ?? 0,
        processing_time_ms: processingTime,
      },
    });
  } catch (err) {
    console.error("[research/deep] Unexpected error:", err);
    res.status(500).json({
      error: sanitizeError(err),
    });
  }
}
