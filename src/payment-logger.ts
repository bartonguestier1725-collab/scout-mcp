/**
 * x402 Payment Logger — records settlements to a shared SQLite DB.
 *
 * All x402 APIs on this machine write to the same DB for unified analytics.
 * DB: ~/.local/share/x402-payments/payments.db
 *
 * Design: fail-open. If logging fails, the payment path is never blocked.
 * Hook-based: register on x402ResourceServer.onAfterSettle / onSettleFailure.
 * Hooks run AFTER the HTTP response is sent, so DB writes don't block users.
 *
 * Uses Node.js built-in node:sqlite (experimental in v24, no external deps).
 * Note: console.error is used for ALL logging because stdout is reserved
 * for the MCP JSON-RPC protocol (console.log is forbidden).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB = join(
  homedir(),
  ".local",
  "share",
  "x402-payments",
  "payments.db",
);

type ErrorSeverity = "critical" | "transient" | "silent";

function classifyError(msg: string): ErrorSeverity {
  if (msg === "") return "silent";

  const lower = msg.toLowerCase();
  if (lower.includes("facilitator settle failed") || lower.includes("settle_exact_failed_onchain")) {
    return "critical";
  }
  if (lower.includes("context deadline") || lower.includes("did not confirm in time") || lower.includes("timeout")) {
    return "transient";
  }
  return "critical";
}

export class PaymentLogger {
  private apiName: string;
  private dbPath: string;
  private enabled: boolean;
  private db: InstanceType<typeof DatabaseSync> | null = null;
  private dropCount = 0;
  private lastRetryAt = 0;
  private readonly RETRY_COOLDOWN_MS = 60_000; // retry init every 60s if disabled

  // Rolling failure tracking for circuit-breaker alerting
  private recentFailures: number[] = [];
  private readonly FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private readonly FAILURE_THRESHOLD = 10; // alert if >10 failures in 5 min
  private lastAlertAt = 0;

  constructor(apiName: string, dbPath?: string) {
    this.apiName = apiName;
    this.dbPath = dbPath ?? process.env.X402_PAYMENTS_DB ?? DEFAULT_DB;
    this.enabled = true;

    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.initSchema();
    } catch (err) {
      console.error(
        `[pay-log] WARNING: init failed, will retry on next write: ${err}`,
      );
      this.enabled = false;
    }
  }

  private getDb(): InstanceType<typeof DatabaseSync> {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA busy_timeout=500");
    }
    return this.db;
  }

  private initSchema(): void {
    const db = this.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        api       TEXT    NOT NULL,
        payer     TEXT    NOT NULL DEFAULT '',
        amount    TEXT    NOT NULL DEFAULT '0',
        network   TEXT    NOT NULL DEFAULT '',
        tx_hash   TEXT    NOT NULL DEFAULT '',
        success   INTEGER NOT NULL DEFAULT 1,
        error     TEXT    NOT NULL DEFAULT '',
        timestamp TEXT    DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_payment_ts ON payment_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_payment_api ON payment_log(api);
      CREATE INDEX IF NOT EXISTS idx_payment_payer ON payment_log(payer);
    `);
  }

  /** Attempt to re-enable after a transient init failure (cooldown: 60s). */
  private tryRecover(): boolean {
    const now = Date.now();
    if (now - this.lastRetryAt < this.RETRY_COOLDOWN_MS) return false;
    this.lastRetryAt = now;
    try {
      this.db = null;
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.initSchema();
      this.enabled = true;
      console.error(`[pay-log] Recovered: DB re-initialized successfully`);
      return true;
    } catch {
      return false;
    }
  }

  private logDrop(err: unknown): void {
    this.dropCount++;
    if (this.dropCount <= 5 || this.dropCount % 100 === 0) {
      console.error(
        `[pay-log] WARNING: write failed (drops: ${this.dropCount}): ${err}`,
      );
    }
  }

  private checkFailureRate(): void {
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter(
      (t) => now - t < this.FAILURE_WINDOW_MS,
    );
    this.recentFailures.push(now);

    if (
      this.recentFailures.length >= this.FAILURE_THRESHOLD &&
      now - this.lastAlertAt > this.FAILURE_WINDOW_MS
    ) {
      this.lastAlertAt = now;
      console.error(
        `[pay-log] ALERT: ${this.apiName} settlement failure rate exceeded ` +
          `threshold: ${this.recentFailures.length} failures in 5 min. ` +
          `Possible Facilitator outage.`,
      );
    }
  }

  /**
   * onAfterSettle hook — logs successful settlement.
   *
   * Bound method suitable for: resourceServer.onAfterSettle(logger.logSettlement)
   */
  logSettlement = async (ctx: {
    result: {
      success: boolean;
      payer?: string;
      transaction: string;
      network: string;
    };
    paymentPayload: {
      accepted?: { amount?: string; network?: string };
    };
    requirements: { amount?: string };
  }): Promise<void> => {
    if (!this.enabled && !this.tryRecover()) return;
    try {
      const result = ctx.result;
      const amount =
        ctx.paymentPayload?.accepted?.amount ??
        ctx.requirements?.amount ??
        "0";

      const db = this.getDb();
      const stmt = db.prepare(
        "INSERT INTO payment_log " +
          "(api, payer, amount, network, tx_hash, success) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      );
      stmt.run(
        this.apiName,
        result.payer ?? "",
        amount,
        result.network ?? "",
        result.transaction ?? "",
        result.success ? 1 : 0,
      );

      console.error(
        `[pay-log] settled api=${this.apiName} ` +
          `payer=${result.payer ?? "?"} ` +
          `amount=${amount} net=${result.network ?? "?"} ` +
          `tx=${(result.transaction ?? "").slice(0, 16)}...`,
      );
    } catch (err) {
      this.logDrop(err);
    }
  };

  /**
   * onSettleFailure hook — logs failed settlement with error classification.
   *
   * Bound method suitable for: resourceServer.onSettleFailure(logger.logFailure)
   *
   * Error severity classification (persisted as prefix in error column):
   * - critical: Facilitator 500, on-chain failure (lost revenue)
   * - transient: Timeout, network congestion (may succeed on retry)
   * - silent: Null/empty error context (logging infrastructure issue)
   */
  logFailure = async (ctx: {
    error: Error;
    paymentPayload: {
      accepted?: { amount?: string; network?: string };
    };
    requirements: { amount?: string; network?: string };
  }): Promise<void> => {
    if (!this.enabled && !this.tryRecover()) return;
    try {
      const amount =
        ctx.paymentPayload?.accepted?.amount ??
        ctx.requirements?.amount ??
        "0";
      const network =
        ctx.paymentPayload?.accepted?.network ??
        ctx.requirements?.network ??
        "";

      const errorMsg = (() => {
        if (!ctx.error) {
          console.error(
            `[pay-log] WARNING: onSettleFailure received null/undefined error. ` +
              `amount=${amount} network=${network}`,
          );
          return "";
        }
        if (ctx.error instanceof Error) {
          return (ctx.error.message || ctx.error.stack || String(ctx.error) || "Unknown Error object");
        }
        return String(ctx.error) || "";
      })();

      const severity = classifyError(errorMsg);
      const taggedError = `[${severity}] ${errorMsg}`;

      const db = this.getDb();
      const stmt = db.prepare(
        "INSERT INTO payment_log " +
          "(api, payer, amount, network, tx_hash, success, error) " +
          "VALUES (?, '', ?, ?, '', 0, ?)",
      );
      stmt.run(
        this.apiName,
        amount,
        network,
        taggedError.slice(0, 500),
      );

      console.error(
        `[pay-log] FAILED api=${this.apiName} severity=${severity} ` +
          `amount=${amount} net=${network} error=${errorMsg.slice(0, 120)}`,
      );

      this.checkFailureRate();
    } catch (err) {
      this.logDrop(err);
    }
  };
}
