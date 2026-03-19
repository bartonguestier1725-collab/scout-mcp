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
  /** Number of retries on 429 responses (default: 1) */
  retries?: number;
}

/**
 * Fetch JSON from a URL with timeout and error handling.
 * Returns the parsed JSON body.
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { timeoutMs = config.TIMEOUT_MS, retries = 1, ...init } = opts;

  const attempt = async (): Promise<T> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: ac.signal });

      if (!res.ok) {
        const retryAfter = res.headers.get("Retry-After");
        // Strip query parameters from URL in error messages to prevent API key leakage
        const safeUrl = (() => {
          try {
            const u = new URL(url);
            return u.origin + u.pathname;
          } catch {
            return url.split("?")[0];
          }
        })();
        throw new ScoutError(
          `HTTP ${res.status} ${res.statusText} from ${safeUrl}`,
          safeUrl,
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
  };

  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ScoutError && err.statusCode === 429 && i < retries) {
        const wait = err.retryAfter
          ? Math.min(err.retryAfter * 1000, 10_000)
          : 2_000 * (i + 1);
        console.error(`[fetch] 429 from ${url}, retry in ${wait}ms (${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }

  // Unreachable, but TypeScript needs it
  throw new ScoutError("Exhausted retries", url);
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
      // Strip query parameters from URL in error messages to prevent API key leakage
      const safeUrl = (() => {
        try {
          const u = new URL(url);
          return u.origin + u.pathname;
        } catch {
          return url.split("?")[0];
        }
      })();
      throw new ScoutError(
        `HTTP ${res.status} ${res.statusText} from ${safeUrl}`,
        safeUrl,
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
