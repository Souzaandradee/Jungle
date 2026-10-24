import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { rows } from '../infra/database/sql';
import { WageringService } from './wagering.service';
import { StructuredLogger } from '../infra/logging/structured-logger';

@Injectable()
export class PendingReferenceWorkerService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly wagering: WageringService,
    private readonly logger: StructuredLogger,
  ) {}

  onModuleInit(): void {
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
        // A consulta só agenda candidatos vencidos; o serviço revalida e bloqueia cada linha antes de reprocessá-la.
        const due = await rows<{ id: string }>(this.em, `
          select id from wager_transactions
          where status = 'PENDING_REFERENCE'
            and (reference_next_attempt_at is null or reference_next_attempt_at <= now())
          order by reference_next_attempt_at nulls first, created_at
          limit 25
        `);
        for (const row of due) {
          if (!this.running) break;
          try { await this.wagering.processPendingReference(row.id); }
          catch (error) {
            this.logger.warn('reference_retry_failed', { transactionId: row.id, errorName: error instanceof Error ? error.name : 'UnknownError' });
          }
        }
      } catch (error) {
        this.logger.error('reference_worker_failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
      }
      await delay(1000);
    }
  }
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
