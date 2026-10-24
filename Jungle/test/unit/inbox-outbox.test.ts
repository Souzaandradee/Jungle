import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionProcessed } from '../../src/domain/events';

describe('InboxMessage', () => {
  test('records processing once and remains processed when marked again', () => {
    const inbox = InboxMessage.receive({
      consumerName: 'wager-transactions-consumer',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(inbox.isProcessed()).toBe(false);
    const processedAt = new Date('2026-01-01T00:00:01.000Z');
    inbox.markProcessed(processedAt);
    inbox.markProcessed(new Date('2026-01-02T00:00:00.000Z'));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toBe(processedAt);
  });

  test('rejects an inbox record without identifiers', () => {
    expect(() => InboxMessage.receive({
      consumerName: ' ', messageId: 'message-1', payloadHash: 'a'.repeat(64), receivedAt: new Date(),
    })).toThrow('INVALID_INBOX_ID');
  });
});

describe('OutboxMessage', () => {
  test('has a stable event id, schedules retry with backoff and becomes published', () => {
    const event = WagerTransactionProcessed.create({
      aggregateId: 'transaction-1',
      data: { transactionId: 'transaction-1', providerId: 'provider', walletId: 'wallet', kind: 'BET', status: 'PROCESSED' },
      context: { correlationId: 'correlation-1' },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    }).toJSON();
    const outbox = OutboxMessage.enqueue(event);
    const now = new Date('2026-01-01T00:00:01.000Z');

    expect(outbox.id).toBe(event.eventId);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(now)).toBe(true);
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 2_000))).toBe(true);
    outbox.markPublished(new Date(now.getTime() + 2_001));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 10_000))).toBe(false);
  });
});
