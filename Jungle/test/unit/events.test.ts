import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/events';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

describe('integration events', () => {
  test('uses a concrete event type and serializes a stable envelope', () => {
    const event = WagerTransactionProcessed.create({
      aggregateId: 'transaction-id',
      data: {
        transactionId: 'transaction-id', providerId: 'provider-a', walletId: 'wallet-id',
        kind: 'BET', status: 'PROCESSED',
      },
      context: { correlationId: 'correlation-id', causationId: 'message-id' },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    }).toJSON();

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(event.correlationId).toBe('correlation-id');
    expect(event.causationId).toBe('message-id');
    expect(event.data.transactionId).toBe('transaction-id');
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('serializes rejection and pending-reference event types', () => {
    const rejected = WagerTransactionRejected.create({
      aggregateId: 'transaction-id',
      data: { transactionId: 'transaction-id', providerId: 'provider-a', walletId: 'wallet-id', kind: 'BET', failureCode: 'INSUFFICIENT_FUNDS' },
      context: { correlationId: 'correlation-id' },
    }).toJSON();
    const pending = WagerTransactionPendingReference.create({
      aggregateId: 'transaction-id',
      data: { transactionId: 'transaction-id', providerId: 'provider-a', walletId: 'wallet-id', referenceExternalTransactionId: 'missing-bet' },
      context: { correlationId: 'correlation-id' },
    }).toJSON();

    expect(rejected.eventType).toBe('WagerTransactionRejected');
    expect(rejected.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(pending.eventType).toBe('WagerTransactionPendingReference');
    expect(pending.data.referenceExternalTransactionId).toBe('missing-bet');
  });

  test('keeps money payloads as decimal strings', () => {
    const event = WalletBalanceChanged.create({
      aggregateId: 'wallet-id',
      data: {
        walletId: 'wallet-id', transactionId: 'transaction-id', providerId: 'provider-a', direction: LedgerDirection.Credit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '5.00', currency: 'BRL' },
        balanceAfter: { amount: '15.00', currency: 'BRL' },
        walletVersion: 2,
      },
      context: { correlationId: 'correlation-id' },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    }).toJSON();

    expect(event.data.money.amount).toBe('10.00');
    expect(typeof event.data.money.amount).toBe('string');
    expect(event.eventType).toBe('WalletBalanceChanged');
  });
});
