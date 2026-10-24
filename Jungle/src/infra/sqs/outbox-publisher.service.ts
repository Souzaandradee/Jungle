import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { SqsClientService } from './sqs-client.service';
import { execute, rows } from '../database/sql';
import { MetricsService } from '../metrics/metrics.service';
import { StructuredLogger } from '../logging/structured-logger';

interface PendingOutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientService,
    private readonly metrics: MetricsService,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.eventsQueueUrl) return;
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.publishBatch();
      } catch (error) {
        this.logger.error('outbox_batch_failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
        this.metrics.recordRetry('outbox');
      }
      await delay(500);
    }
  }

  private async publishBatch(): Promise<void> {
    await this.em.transactional(async (tx) => {
      // SKIP LOCKED permite publishers em instâncias diferentes reivindicarem lotes sem bloquear uns aos outros.
      const pending = await rows<PendingOutboxRow>(tx, `
        select id, aggregate_id, event_type, payload, attempts, created_at
        from outbox_messages
        where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
        order by created_at asc
        limit 10
        for update skip locked
      `);

      for (const row of pending) {
        try {
          // aggregate_id define o agregado/grupo FIFO; pode ser uma wallet e não equivale necessariamente a transactionId.
          // A entrega é pelo menos uma vez: a linha só fica marcada após o envio, então eventId estável permite deduplicar redeliveries.
          await this.sqs.send(this.sqs.eventsQueueUrl, JSON.stringify(row.payload), row.aggregate_id, row.id);
          await execute(tx, 'update outbox_messages set published_at = now() where id = $1', [row.id]);
          this.logger.info('outbox_event_published', outboxLogContext(row));
        } catch (error) {
          const attempts = row.attempts + 1;
          const delaySeconds = Math.min(2 ** Math.min(attempts, 6), 60);
          await execute(tx, `
            update outbox_messages set attempts = $1, next_attempt_at = $2 where id = $3
          `, [attempts, new Date(Date.now() + delaySeconds * 1000), row.id]);
          this.metrics.recordRetry('outbox');
          this.logger.warn('outbox_event_retry_scheduled', {
            ...outboxLogContext(row),
            attempt: attempts, errorName: error instanceof Error ? error.name : 'PublishError',
          });
        }
      }

      const lagRows = await rows<{ lag_seconds: string | null }>(tx, `
        select extract(epoch from (now() - min(created_at)))::text as lag_seconds
        from outbox_messages where published_at is null
      `);
      this.metrics.recordOutboxLag(Number(lagRows[0]?.lag_seconds ?? 0));
    });
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function outboxLogContext(row: PendingOutboxRow): Record<string, unknown> {
  const data = recordValue(row.payload.data);
  return {
    correlationId: stringValue(row.payload, 'correlationId'),
    messageId: stringValue(row.payload, 'eventId') ?? row.id,
    // The aggregate can be a wallet; transactionId must come from event data instead.
    transactionId: stringValue(data, 'transactionId'),
    walletId: stringValue(data, 'walletId'),
    providerId: stringValue(data, 'providerId'),
    eventType: row.event_type,
  };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
