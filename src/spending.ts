import { L402BudgetError } from "./errors.js";

export interface SpendingLimit {
  maxPerPaymentSats: number;
  maxTotalSats: number;
  maxPaymentsPerMinute: number;
}

export interface SpendingRecord {
  amount: number;
  url: string;
  timestamp: number;
}

export class SpendingTracker {
  private history: SpendingRecord[] = [];
  private totalSpent = 0;

  constructor(private limits: SpendingLimit) {}

  check(amountSats: number): void {
    if (amountSats > this.limits.maxPerPaymentSats) {
      throw new L402BudgetError(
        `Payment of ${amountSats} sats exceeds per-payment limit of ${this.limits.maxPerPaymentSats} sats`,
      );
    }

    if (this.totalSpent + amountSats > this.limits.maxTotalSats) {
      throw new L402BudgetError(
        `Payment of ${amountSats} sats would exceed total budget. Spent: ${this.totalSpent}/${this.limits.maxTotalSats} sats`,
      );
    }

    const oneMinuteAgo = Date.now() - 60_000;
    const recentPayments = this.history.filter(
      (r) => r.timestamp > oneMinuteAgo,
    );
    if (recentPayments.length >= this.limits.maxPaymentsPerMinute) {
      throw new L402BudgetError(
        `Rate limit: ${this.limits.maxPaymentsPerMinute} payments per minute exceeded`,
      );
    }
  }

  record(amountSats: number, url: string): void {
    const now = Date.now();
    this.history.push({
      amount: amountSats,
      url,
      timestamp: now,
    });
    this.totalSpent += amountSats;

    // Prune records older than 1 minute (only needed for rate limiting)
    const oneMinuteAgo = now - 60_000;
    const firstRecentIndex = this.history.findIndex(
      (r) => r.timestamp > oneMinuteAgo,
    );
    if (firstRecentIndex > 0) {
      this.history = this.history.slice(firstRecentIndex);
    }
  }

  get spent(): number {
    return this.totalSpent;
  }

  get remaining(): number {
    return this.limits.maxTotalSats - this.totalSpent;
  }

  get paymentCount(): number {
    return this.history.length;
  }

  reset(): void {
    this.history = [];
    this.totalSpent = 0;
  }
}
