/**
 * Scout MCP – shared type definitions
 */

export interface ToolResult {
  success: boolean;
  data: unknown;
  source: string;
  query: string;
  count: number;
  cost_estimate?: { usd: number; breakdown: Record<string, number> };
  error?: string;
  elapsed_ms: number;
}

export class ScoutError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}

/** Helper to build a successful ToolResult */
export function ok(
  source: string,
  query: string,
  data: unknown,
  count: number,
  elapsed_ms: number,
  cost_estimate?: ToolResult["cost_estimate"],
): ToolResult {
  return { success: true, data, source, query, count, elapsed_ms, cost_estimate };
}

/** Helper to build a failed ToolResult */
export function fail(
  source: string,
  query: string,
  error: string,
  elapsed_ms: number,
): ToolResult {
  return { success: false, data: null, source, query, count: 0, error, elapsed_ms };
}
