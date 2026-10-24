import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { IntegrationEvent } from '../../domain/events';
import { OutboxMessage } from '../../domain/outbox-message';
import { execute } from './sql';

@Injectable()
export class OutboxWriter {
  async enqueue(tx: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
    // O envelope é gravado na transação fornecida pelo caso de uso, evitando publicar eventos de operações revertidas.
    const envelope = event.toJSON();
    const message = OutboxMessage.enqueue(envelope);
    await execute(tx, `
      insert into outbox_messages
        (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, created_at)
      values ($1, $2, $3, $4::jsonb, $5, 0, $5, now())
    `, [
      message.id,
      message.aggregateId,
      message.eventType,
      JSON.stringify(envelope),
      message.occurredAt,
    ]);
  }
}
