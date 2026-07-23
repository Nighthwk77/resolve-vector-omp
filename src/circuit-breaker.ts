/**
 * Per-reviewer circuit breaker.
 *
 * A generation timeout, transport failure, or malformed/empty stream OPENS
 * the seat's circuit: subsequent councils skip it for a cooldown (default 5
 * minutes) instead of making the user wait on a dead seat again. When the
 * cooldown elapses the next council gets ONE half-open trial; a successful
 * meaningful completion closes the circuit, another failure re-opens it.
 * `/rv doctor` (probe) and `/rv reviewer retry <id>` can force a half-open
 * probe early.
 *
 * State is process-local; receipts carry the circuit state per reviewer so
 * the durable record shows who was skipped and why.
 */
import type { FailureCategory } from "./stream-guard.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitSnapshot {
  state: CircuitState;
  /** Why the circuit opened (failure category), when not closed. */
  reason?: string;
  /** Remaining cooldown ms before an automatic half-open trial. 0 when closed/half-open. */
  remainingMs: number;
}

interface CircuitEntry {
  openedAt: number;
  reason: string;
  halfOpen: boolean;
}

export interface CircuitBreakerOptions {
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreakerRegistry {
  /** Cooldown is mutable so a config reload can retune it without losing state. */
  cooldownMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CircuitEntry>();

  constructor(options: CircuitBreakerOptions) {
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Gate before dispatch. Returns undefined when the seat may run (closed, or
   * an expired circuit converting to its one half-open trial). Returns the
   * snapshot when the seat MUST be skipped.
   */
  check(reviewerId: string): CircuitSnapshot | undefined {
    const entry = this.entries.get(reviewerId);
    if (!entry) return undefined;
    if (entry.halfOpen) return undefined; // trial already granted
    const remaining = this.cooldownMs - (this.now() - entry.openedAt);
    if (remaining <= 0) {
      entry.halfOpen = true; // automatic half-open trial for the next call
      return undefined;
    }
    return { state: "open", reason: entry.reason, remainingMs: remaining };
  }

  /** A successful meaningful completion closes the circuit. */
  recordSuccess(reviewerId: string): void {
    this.entries.delete(reviewerId);
  }

  /** A generation/transport/streaming failure opens (or re-opens) the circuit. */
  recordFailure(reviewerId: string, category: FailureCategory): CircuitSnapshot {
    this.entries.set(reviewerId, { openedAt: this.now(), reason: category, halfOpen: false });
    return { state: "open", reason: category, remainingMs: this.cooldownMs };
  }

  /** Force one half-open probe now (doctor / `/rv reviewer retry`). */
  beginProbe(reviewerId: string): CircuitSnapshot {
    const entry = this.entries.get(reviewerId);
    if (!entry) return { state: "closed", remainingMs: 0 };
    entry.halfOpen = true;
    return { state: "half_open", reason: entry.reason, remainingMs: 0 };
  }

  /** Read-only view for status/doctor/receipts. Never mutates. */
  snapshot(reviewerId: string): CircuitSnapshot {
    const entry = this.entries.get(reviewerId);
    if (!entry) return { state: "closed", remainingMs: 0 };
    if (entry.halfOpen) return { state: "half_open", reason: entry.reason, remainingMs: 0 };
    const remaining = Math.max(0, this.cooldownMs - (this.now() - entry.openedAt));
    return { state: "open", reason: entry.reason, remainingMs: remaining };
  }

  /** Snapshots for every seat with non-closed state. */
  all(): Map<string, CircuitSnapshot> {
    const out = new Map<string, CircuitSnapshot>();
    for (const id of this.entries.keys()) out.set(id, this.snapshot(id));
    return out;
  }
}
