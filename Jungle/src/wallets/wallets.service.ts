import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../domain/events';
import { OutboxWriter } from '../infra/database/outbox-writer';
import { StructuredLogger } from '../infra/logging/structured-logger';
import { MetricsService } from '../infra/metrics/metrics.service';
import { execute, rows } from '../infra/database/sql';
import { CreateWalletDto } from './wallets.dto';

type DbWallet = {
  id: string; player_id: string; currency: string; balance_amount: string;
  version: number; created_at: Date | string; updated_at: Date | string;
};

type DbLedger = {
  id: string; wallet_id: string; transaction_id: string; direction: LedgerDirection;
  amount: string; currency: string; balance_before: string; balance_after: string; created_at: Date | string;
};

@Injectable()
export class WalletsService {
  constructor(
    private readonly em: EntityManager,
    private readonly outbox: OutboxWriter,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  async create(dto: CreateWalletDto): Promise<Record<string, unknown>> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(dto.initialBalance);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid initial balance.');
    }

    const id = randomUUID();
    const wallet = Wallet.open({ id, playerId: dto.playerId, initialBalance });
    const now = new Date();
    try {
      // Wallet, transação OPENING, ledger e eventos de outbox precisam confirmar ou reverter juntos.
      await this.em.transactional(async (tx) => {
        await execute(tx, `
          insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
          values ($1,$2,$3,$4,1,$5,$5)
        `, [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, now]);

        if (initialBalance.isPositive()) {
          const transactionId = randomUUID();
          const idempotencyKey = `opening:${wallet.id}`;
          const payloadHash = createHash('sha256')
            .update(JSON.stringify({ walletId: wallet.id, initialBalance: initialBalance.toJSON() })).digest('hex');
          await execute(tx, `
            insert into wager_transactions (
              id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency,
              status, processed_at, response_balance_amount, response_balance_currency, created_at
            ) values ($1,'internal',$2,$3,$4,$5,$6,'opening','internal','OPENING',$7,$8,'PROCESSED',$9,$7,$8,$9)
          `, [transactionId, `opening:${wallet.id}`, idempotencyKey, payloadHash, wallet.id, wallet.playerId,
            initialBalance.toJSON().amount, wallet.currency, now]);

          const ledger = WalletLedgerEntry.create({
            id: randomUUID(), walletId: wallet.id, transactionId, direction: LedgerDirection.Credit,
            money: initialBalance, balanceBefore: Money.zero(wallet.currency), balanceAfter: initialBalance, createdAt: now,
          });
          await execute(tx, `
            insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [ledger.id, ledger.walletId, ledger.transactionId, ledger.direction, ledger.money.toJSON().amount,
            ledger.money.currency, ledger.balanceBefore.toJSON().amount, ledger.balanceAfter.toJSON().amount, now]);

          await this.outbox.enqueue(tx, WagerTransactionProcessed.create({
            aggregateId: transactionId,
            data: { transactionId, providerId: 'internal', walletId: wallet.id, kind: 'OPENING', status: 'PROCESSED' },
            context: { correlationId: transactionId, causationId: transactionId },
            occurredAt: now,
          }));
          await this.outbox.enqueue(tx, WalletBalanceChanged.create({
            aggregateId: wallet.id,
            data: {
              walletId: wallet.id, transactionId, providerId: 'internal', direction: LedgerDirection.Credit,
              money: initialBalance.toJSON(), balanceBefore: Money.zero(wallet.currency).toJSON(),
              balanceAfter: initialBalance.toJSON(), walletVersion: wallet.version,
            },
            context: { correlationId: transactionId, causationId: transactionId },
            occurredAt: now,
          }));
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('A wallet already exists for this player and currency.');
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async get(walletId: string): Promise<Record<string, unknown>> {
    const found = await rows<DbWallet>(this.em, 'select * from wallets where id = $1', [walletId]);
    if (!found[0]) throw new NotFoundException('Wallet not found.');
    const row = found[0];
    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: fixed(row.balance_amount), currency: row.currency },
      version: row.version,
      createdAt: toDate(row.created_at).toISOString(),
      updatedAt: toDate(row.updated_at).toISOString(),
    };
  }

  async ledger(walletId: string, cursor?: string, requestedLimit?: string): Promise<Record<string, unknown>> {
    const limit = requestedLimit === undefined ? 50 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100.');
    }
    const wallet = await rows<{ id: string }>(this.em, 'select id from wallets where id = $1', [walletId]);
    if (!wallet[0]) throw new NotFoundException('Wallet not found.');

    let result: DbLedger[];
    if (cursor) {
      const decoded = decodeCursor(cursor);
      result = await rows<DbLedger>(this.em, `
        select * from wallet_ledger_entries
        where wallet_id = $1 and (created_at, id) < ($2::timestamptz, $3::uuid)
        order by created_at desc, id desc limit $4
      `, [walletId, decoded.createdAt, decoded.id, limit + 1]);
    } else {
      result = await rows<DbLedger>(this.em, `
        select * from wallet_ledger_entries where wallet_id = $1
        order by created_at desc, id desc limit $2
      `, [walletId, limit + 1]);
    }

    const hasMore = result.length > limit;
    const page = hasMore ? result.slice(0, limit) : result;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: fixed(row.amount), currency: row.currency },
        balanceBefore: { amount: fixed(row.balance_before), currency: row.currency },
        balanceAfter: { amount: fixed(row.balance_after), currency: row.currency },
        createdAt: toDate(row.created_at).toISOString(),
      })),
      ...(hasMore && last ? { nextCursor: encodeCursor(toDate(last.created_at).toISOString(), last.id) } : {}),
    };
  }

  async reconcile(walletId: string): Promise<Record<string, unknown>> {
    // Read the stored balance and ledger aggregate in one statement so a concurrent
    // transaction cannot make the two sides come from different READ COMMITTED snapshots.
    const reconciliationRows = await rows<DbWallet & { calculated_balance: string; checked_entries: string }>(this.em, `
      select w.*,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated_balance,
        count(l.id)::text as checked_entries
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = $1
      group by w.id
    `, [walletId]);
    if (!reconciliationRows[0]) throw new NotFoundException('Wallet not found.');
    const wallet = reconciliationRows[0];
    const stored = Money.from({ amount: wallet.balance_amount, currency: wallet.currency });
    // SUM(numeric) is deliberately not cast back to numeric(20,2): cumulative credits
    // and debits can exceed the wallet column's range even while the net balance is valid.
    const calculatedValue = new Decimal(wallet.calculated_balance);
    const storedValue = new Decimal(stored.toJSON().amount);
    const differenceValue = storedValue.minus(calculatedValue);
    const calculated = { amount: calculatedValue.toFixed(2), currency: wallet.currency };
    const difference = { amount: differenceValue.toFixed(2), currency: wallet.currency };
    const consistent = differenceValue.isZero();
    const checkedEntries = Number(wallet.checked_entries);
    if (!consistent) {
      this.metrics.recordReconciliationMismatch();
      this.logger.warn('wallet_reconciliation_mismatch', {
        walletId, checkedEntries,
        currency: wallet.currency, discrepancy: true,
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated,
      difference,
      consistent,
      checkedEntries,
    };
  }
}

function fixed(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${(fraction + '00').slice(0, 2)}`;
}

function toDate(value: Date | string): Date { return value instanceof Date ? value : new Date(value); }

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator <= 0 || Number.isNaN(Date.parse(createdAt))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('invalid');
    }
    return { createdAt, id };
  } catch {
    throw new BadRequestException('cursor is invalid.');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
}
