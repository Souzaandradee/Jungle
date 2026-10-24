import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly transactions: Counter<string>;
  private readonly duplicates: Counter<string>;
  private readonly retries: Counter<string>;
  private readonly dlqMessages: Gauge<string>;
  private readonly lockConflicts: Counter<string>;
  private readonly outboxLag: Gauge<string>;
  private readonly processingLatency: Histogram<string>;
  private readonly reconciliationMismatches: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.transactions = new Counter({
      name: 'wager_transactions_total', help: 'Wager transactions by final/current status.', labelNames: ['status'], registers: [this.registry],
    });
    this.duplicates = new Counter({
      name: 'wager_idempotent_duplicates_total', help: 'Persistently detected duplicate submissions.', registers: [this.registry],
    });
    this.retries = new Counter({
      name: 'wager_retries_total', help: 'Retried message/outbox/reference operations.', labelNames: ['source'], registers: [this.registry],
    });
    this.dlqMessages = new Gauge({
      name: 'wager_dlq_messages', help: 'Approximate number of messages visible in the dead-letter queue.', registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: 'wager_lock_conflicts_total', help: 'Database deadlock or serialization conflicts.', registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: 'wager_outbox_lag_seconds', help: 'Age in seconds of the oldest pending outbox event.', registers: [this.registry],
    });
    this.processingLatency = new Histogram({
      name: 'wager_processing_latency_seconds', help: 'Wager processing latency in seconds.', registers: [this.registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    });
    this.reconciliationMismatches = new Counter({
      name: 'wager_reconciliation_mismatches_total', help: 'Wallet reconciliations where materialized balance differs from the ledger.', registers: [this.registry],
    });
  }

  recordStatus(status: string): void { this.transactions.inc({ status }); }
  recordDuplicate(): void { this.duplicates.inc(); }
  recordRetry(source: 'sqs' | 'outbox' | 'reference'): void { this.retries.inc({ source }); }
  recordDlqMessages(count: number): void { this.dlqMessages.set(count); }
  recordLockConflict(): void { this.lockConflicts.inc(); }
  observeProcessing(seconds: number): void { this.processingLatency.observe(seconds); }
  recordOutboxLag(seconds: number): void { this.outboxLag.set(seconds); }
  recordReconciliationMismatch(): void { this.reconciliationMismatches.inc(); }

  async metrics(): Promise<string> { return this.registry.metrics(); }
  contentType(): string { return this.registry.contentType; }
}
