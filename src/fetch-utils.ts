/**
 * Scout MCP – HTTP fetch utilities
 *
 * Wraps the built-in Node 24 fetch with:
 *  - AbortController-based timeout
 *  - Automatic JSON parsing
 *  - HTTP error → ScoutError conversion
 *  - 429 rate-limit awareness (Retry-After propagation)
 */

import { config } from "./config.js";
import { ScoutError } from "./types.js";

export interface FetchOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
}

/**
 * Fetch JSON from a URL with timeout and error handling.
 * Returns the parsed JSON body.
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { timeoutMs = config.TIMEOUT_MS, ...init } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: ac.signal });

    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      throw new ScoutError(
        `HTTP ${res.status} ${res.statusText} from ${url}`,
        url,
        res.status,
        retryAfter ? Number(retryAfter) : undefined,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ScoutError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ScoutError(`Request timed out after ${timeoutMs}ms`, url);
    }
    throw new ScoutError(
      err instanceof Error ? err.message : String(err),
      url,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch raw text (for HTML scraping).
 */
export async function safeFetchText(
  url: string,
  opts: FetchOptions = {},
): Promise<string> {
  const { timeoutMs = config.TIMEOUT_MS, ...init } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: ac.signal });

    if (!res.ok) {
      throw new ScoutError(
        `HTTP ${res.status} ${res.statusText} from ${url}`,
        url,
        res.status,
      );
    }

    return await res.text();
  } catch (err) {
    if (err instanceof ScoutError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ScoutError(`Request timed out after ${timeoutMs}ms`, url);
    }
    throw new ScoutError(
      err instanceof Error ? err.message : String(err),
      url,
    );
  } finally {
    clearTimeout(timer);
  }
}
