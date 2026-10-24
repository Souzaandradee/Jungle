import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';

const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Wallet', () => {
  test('does not allow a debit below zero', () => {
    const wallet = Wallet.open({ id: 'wallet-id', playerId: 'player-id', initialBalance: money('100.00') });
    expect(() => wallet.debit(money('100.01'))).toThrow('INSUFFICIENT_FUNDS');
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('increments the version only when the balance changes', () => {
    const wallet = Wallet.open({ id: 'wallet-id', playerId: 'player-id', initialBalance: money('100.00') });
    wallet.debit(money('0.00'));
    expect(wallet.version).toBe(1);
    wallet.debit(money('25.00'));
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  test('does not allow a credit to overflow the database money precision', () => {
    const wallet = Wallet.open({
      id: 'wallet-id', playerId: 'player-id',
      initialBalance: money('999999999999999999.99'),
    });
    expect(() => wallet.credit(money('0.01'))).toThrow('MONEY_AMOUNT_OUT_OF_RANGE');
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });

  test('rejects money in a different currency', () => {
    const wallet = Wallet.open({ id: 'wallet-id', playerId: 'player-id', initialBalance: money('100.00') });
    expect(() => wallet.credit(money('1.00', 'USD'))).toThrow('CURRENCY_MISMATCH');
  });

  test('rejects negative initial balance and negative credit/debit', () => {
    expect(() => Wallet.open({
      id: 'wallet-id', playerId: 'player-id', initialBalance: money('0.00').subtract(money('1.00')),
    })).toThrow('NEGATIVE_INITIAL_BALANCE');

    const wallet = Wallet.open({ id: 'wallet-id', playerId: 'player-id', initialBalance: money('10.00') });
    const negative = money('1.00').negate();
    expect(() => wallet.credit(negative)).toThrow('NEGATIVE_CREDIT');
    expect(() => wallet.debit(negative)).toThrow('NEGATIVE_DEBIT');
    expect(wallet.balance.toJSON().amount).toBe('10.00');
  });

  test('rehydrates persisted state without incrementing version', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'wallet-id', playerId: 'player-id', currency: 'BRL', balance: money('12.34'),
      version: 7, createdAt: now, updatedAt: now,
    });
    expect(wallet.balance.toJSON().amount).toBe('12.34');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toBe(now);
  });
});

describe('WalletLedgerEntry', () => {
  test('verifies debit arithmetic', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id', walletId: 'wallet-id', transactionId: 'tx-id',
      direction: LedgerDirection.Debit, money: money('20.00'),
      balanceBefore: money('50.00'), balanceAfter: money('30.00'), createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('verifies credit arithmetic', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-id', walletId: 'wallet-id', transactionId: 'tx-id',
      direction: LedgerDirection.Credit, money: money('20.00'),
      balanceBefore: money('50.00'), balanceAfter: money('70.00'), createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects an unbalanced entry', () => {
    expect(() => WalletLedgerEntry.create({
      id: 'ledger-id', walletId: 'wallet-id', transactionId: 'tx-id',
      direction: LedgerDirection.Credit, money: money('20.00'),
      balanceBefore: money('50.00'), balanceAfter: money('60.00'), createdAt: new Date(),
    })).toThrow('UNBALANCED_LEDGER_ENTRY');
  });
});

describe('WagerTransaction', () => {
  const create = (kind: WagerTransactionKind, referenceExternalTransactionId?: string) => WagerTransaction.create({
    id: 'tx-id', providerId: 'provider', externalTransactionId: 'external-id',
    idempotencyKey: 'provider:external-id', payloadHash: 'a'.repeat(64), walletId: 'wallet-id',
    playerId: 'player-id', roundId: 'round-id', gameId: 'game-id', kind, money: money('10.00'),
    referenceExternalTransactionId,
  });

  test('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => create(WagerTransactionKind.Refund)).toThrow('REFERENCE_REQUIRED');
    expect(() => create(WagerTransactionKind.Rollback)).toThrow('REFERENCE_REQUIRED');
  });

  test('does not allow OPENING through provider input', () => {
    expect(() => create(WagerTransactionKind.Opening)).toThrow('OPENING_IS_INTERNAL');
  });

  test('terminal status cannot be transitioned again', () => {
    const processed = create(WagerTransactionKind.Bet);
    processed.markProcessed(undefined, new Date());
    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(() => processed.reject('ANY_CODE')).toThrow('INVALID_TRANSACTION_STATE');

    const rejected = create(WagerTransactionKind.Loss);
    rejected.reject('BUSINESS_RULE');
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('BUSINESS_RULE');
    expect(() => rejected.markPendingReference()).toThrow('INVALID_TRANSACTION_STATE');

    const failed = create(WagerTransactionKind.Bet);
    failed.fail('INFRASTRUCTURE_FAILURE');
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(() => failed.markProcessed(undefined, new Date())).toThrow('INVALID_TRANSACTION_STATE');
  });

  test('maps each business operation to the expected ledger behavior', () => {
    expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(WagerTransactionKind.Refund, 'bet-id').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(WagerTransactionKind.Loss).ledgerDirectionFor()).toBeUndefined();

    expect(create(WagerTransactionKind.Rollback, 'tx-id').ledgerDirectionFor({
      kind: WagerTransactionKind.Bet, ledgerDirection: LedgerDirection.Debit,
    })).toBe(LedgerDirection.Credit);
    expect(create(WagerTransactionKind.Rollback, 'tx-id').ledgerDirectionFor({
      kind: WagerTransactionKind.Win, ledgerDirection: LedgerDirection.Credit,
    })).toBe(LedgerDirection.Debit);
  });

  test('LOSS does not affect the wallet balance', () => {
    expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(create(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
  });

  test('matches the stored business payload hash and detects divergence', () => {
    const transaction = create(WagerTransactionKind.Bet);
    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });
});
