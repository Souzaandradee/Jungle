import Decimal from 'decimal.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { Money, MoneyProps } from '../domain/money';
import { canonicalPayloadHash } from '../domain/idempotency';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events';
import { StructuredLogger } from '../infra/logging/structured-logger';
import { MetricsService } from '../infra/metrics/metrics.service';
import { OutboxWriter } from '../infra/database/outbox-writer';
import { execute, rows } from '../infra/database/sql';
import { SubmitWagerTransactionDto } from './wagering.dto';
import { PROVIDER_IDENTITY_PORT, ProviderIdentityPort } from '../infra/auth/provider-identity.port';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_REFERENCE_ATTEMPTS = 10;

type DbWallet = {
  id: string; player_id: string; currency: string; balance_amount: string;
  version: number; created_at: Date | string; updated_at: Date | string;
};

type DbWagerTransaction = {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string;
  payload_hash: string; wallet_id: string; player_id: string; round_id: string; game_id: string;
  kind: WagerTransactionKind; amount: string; currency: string; reference_external_transaction_id?: string | null;
  reference_transaction_id?: string | null; status: WagerTransactionStatus; failure_code?: string | null;
  processed_at?: Date | string | null; response_balance_amount?: string | null;
  response_balance_currency?: string | null; reference_attempts: number;
  reference_next_attempt_at?: Date | string | null; created_at: Date | string;
};

type DbLedger = {
  id: string; wallet_id: string; transaction_id: string; direction: LedgerDirection;
  amount: string; currency: string; balance_before: string; balance_after: string; created_at: Date | string;
};

export interface ProcessContext {
  correlationId?: string;
  messageId?: string;
  consumerName?: string;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
  inboxDuplicate?: boolean;
}

@Injectable()
export class WageringService {
  constructor(
    private readonly em: EntityManager,
    private readonly outbox: OutboxWriter,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  async submit(input: SubmitWagerTransactionDto, idempotencyKey: string, context: ProcessContext = {}): Promise<WagerResult> {
    const startedAt = Date.now();
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key header is required.');
    if (idempotencyKey.length > 512) throw new BadRequestException('Idempotency-Key is too long.');

    let money: Money;
    await this.providerIdentity.assertProviderIdentity(input.providerId);
    try {
      money = Money.from(input.money);
      WagerTransaction.create({
        id: randomUUID(), providerId: input.providerId, externalTransactionId: input.externalTransactionId,
        idempotencyKey, payloadHash: '0'.repeat(64), walletId: input.walletId, playerId: input.playerId,
        roundId: input.roundId, gameId: input.gameId, kind: input.kind as WagerTransactionKind,
        money, referenceExternalTransactionId: input.referenceExternalTransactionId,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid transaction.');
    }

    const normalizedInput = { ...input, money: money.toJSON() };
    // Hash somente dos campos de negócio normalizados; a chave de idempotência e o contexto SQS não entram no hash.
    const payloadHash = canonicalPayloadHash({
      providerId: normalizedInput.providerId,
      externalTransactionId: normalizedInput.externalTransactionId,
      playerId: normalizedInput.playerId,
      walletId: normalizedInput.walletId,
      roundId: normalizedInput.roundId,
      gameId: normalizedInput.gameId,
      kind: normalizedInput.kind,
      money: normalizedInput.money,
      referenceExternalTransactionId: normalizedInput.referenceExternalTransactionId ?? null,
    });
    const correlationId = context.correlationId ?? randomUUID();

    let result: WagerResult;
    try {
      // Inbox, transação financeira, ledger e outbox compartilham o commit: não confirmar só parte do efeito.
      result = await this.em.transactional(async (tx) => {
      if (context.messageId) {
        const inboxRows = await rows<{ message_id: string }>(tx, `
          insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
          values ($1, $2, $3, now())
          on conflict (consumer_name, message_id) do nothing
          returning message_id
        `, [context.consumerName ?? CONSUMER_NAME, context.messageId, payloadHash]);
        if (inboxRows.length === 0) {
          const storedInbox = await rows<{ payload_hash: string }>(tx, `
            select payload_hash from inbox_messages
            where consumer_name = $1 and message_id = $2
          `, [context.consumerName ?? CONSUMER_NAME, context.messageId]);
          if (storedInbox[0] && storedInbox[0].payload_hash !== payloadHash) {
            throw new ConflictException('SQS messageId was already used with a different payload.');
          }
          return { inboxDuplicate: true } as WagerResult;
        }
      }

      const walletExists = await rows<{ id: string }>(tx,
        'select id from wallets where id = $1', [input.walletId]);
      if (!walletExists[0]) throw new NotFoundException('Wallet not found.');

      const id = randomUUID();
      const inserted = await rows<DbWagerTransaction>(tx, `
        insert into wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          reference_external_transaction_id, status, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING',now())
        on conflict do nothing
        returning *
      `, [
        id, input.providerId, input.externalTransactionId, idempotencyKey, payloadHash,
        input.walletId, input.playerId, input.roundId, input.gameId, input.kind,
        money.toJSON().amount, money.currency, input.referenceExternalTransactionId ?? null,
      ]);

      let outcome: WagerResult;
      if (inserted.length === 0) {
        const existingByKey = await rows<DbWagerTransaction>(tx,
          'select * from wager_transactions where idempotency_key = $1', [idempotencyKey]);
        if (existingByKey[0]) {
          if (existingByKey[0].payload_hash !== payloadHash) {
            throw new ConflictException('Idempotency-Key was already used with a different business payload.');
          }
          outcome = this.resultFromStored(existingByKey[0], true);
        } else {
          throw new ConflictException('Provider transaction id was already used with another Idempotency-Key.');
        }
      } else {
        outcome = await this.applyTransaction(tx, inserted[0], normalizedInput, {
          correlationId, messageId: context.messageId,
        });
      }

      if (context.messageId) {
        await execute(tx, `
          update inbox_messages set processed_at = now()
          where consumer_name = $1 and message_id = $2
        `, [context.consumerName ?? CONSUMER_NAME, context.messageId]);
      }
      return outcome;
      });
    } catch (error) {
      if (isLockConflict(error)) this.metrics.recordLockConflict();
      throw error;
    }

    this.metrics.observeProcessing((Date.now() - startedAt) / 1000);
    if (result.inboxDuplicate) {
      this.metrics.recordDuplicate();
      this.logger.info('sqs_message_duplicate', { correlationId, messageId: context.messageId, providerId: input.providerId, walletId: input.walletId });
      return result;
    }
    if (result.idempotentReplay) this.metrics.recordDuplicate();
    else this.metrics.recordStatus(result.status);
    this.logger.info(result.idempotentReplay ? 'wager_idempotent_replay' : 'wager_transaction_completed', {
      correlationId, messageId: context.messageId, transactionId: result.transactionId,
      walletId: input.walletId, providerId: input.providerId, status: result.status,
      idempotentReplay: result.idempotentReplay,
    });
    return result;
  }

  /** Called by the retry worker. Row-level locking makes duplicate schedulers safe. */
  async processPendingReference(transactionId: string): Promise<void> {
    const correlationId = randomUUID();
    const result = await this.em.transactional(async (tx) => {
      const due = await rows<DbWagerTransaction>(tx, `
        select * from wager_transactions
        where id = $1 and status = 'PENDING_REFERENCE'
          and (reference_next_attempt_at is null or reference_next_attempt_at <= now())
        for update skip locked
      `, [transactionId]);
      if (!due[0]) return undefined;
      await execute(tx, `update wager_transactions set status = 'PENDING', reference_next_attempt_at = null where id = $1`, [transactionId]);
      const pendingInput = this.inputFromRow(due[0]);
      const refreshed = { ...due[0], status: WagerTransactionStatus.Pending };
      return this.applyTransaction(tx, refreshed, pendingInput, { correlationId, messageId: undefined });
    });

    if (!result) return;
    this.metrics.recordRetry('reference');
    this.metrics.recordStatus(result.status);
    this.logger.info('pending_reference_reprocessed', {
      correlationId, transactionId: result.transactionId,
      walletId: undefined, providerId: undefined, status: result.status,
    });
  }

  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    const found = await rows<DbWagerTransaction>(this.em, 'select * from wager_transactions where id = $1', [transactionId]);
    if (!found[0]) throw new NotFoundException('Wager transaction not found.');
    return this.serializeTransaction(found[0]);
  }

  async getByProviderTransaction(providerId: string, externalTransactionId: string): Promise<Record<string, unknown>> {
    const found = await rows<DbWagerTransaction>(this.em, `
      select * from wager_transactions where provider_id = $1 and external_transaction_id = $2
    `, [providerId, externalTransactionId]);
    if (!found[0]) throw new NotFoundException('Wager transaction not found.');
    return this.serializeTransaction(found[0]);
  }

  private async applyTransaction(
    tx: EntityManager,
    row: DbWagerTransaction,
    input: SubmitWagerTransactionDto,
    context: { correlationId: string; messageId?: string },
  ): Promise<WagerResult> {
    const now = new Date();
    const transaction = WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: Money.from({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      createdAt: toDate(row.created_at),
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: row.failure_code ?? undefined,
      processedAt: row.processed_at ? toDate(row.processed_at) : undefined,
    });

    // Serializa alterações da mesma wallet antes de validar saldo; wallets diferentes não compartilham lock global.
    const wallets = await rows<DbWallet>(tx,
      'select * from wallets where id = $1 for no key update', [row.wallet_id]);
    if (!wallets[0]) throw new NotFoundException('Wallet not found.');
    const walletRow = wallets[0];
    const wallet = Wallet.rehydrate({
      id: walletRow.id,
      playerId: walletRow.player_id,
      currency: walletRow.currency,
      balance: Money.from({ amount: walletRow.balance_amount, currency: walletRow.currency }),
      version: walletRow.version,
      createdAt: toDate(walletRow.created_at),
      updatedAt: toDate(walletRow.updated_at),
    });

    if (wallet.playerId !== row.player_id) {
      return this.reject(tx, row, transaction, wallet, 'WALLET_PLAYER_MISMATCH', context, now);
    }
    if (wallet.currency !== row.currency) {
      return this.reject(tx, row, transaction, wallet, 'CURRENCY_MISMATCH', context, now);
    }

    // Referências são validadas antes de aplicar o saldo: tipo, estado, provedor, jogador, wallet, rodada e valor importam.
    let reference: DbWagerTransaction | undefined;
    let referenceLedger: DbLedger | undefined;
    const referenceRequiredOrProvided = transaction.requiresReference()
      || (transaction.kind === WagerTransactionKind.Win && Boolean(transaction.referenceExternalTransactionId));

    if (referenceRequiredOrProvided) {
      const referenceRows = await rows<DbWagerTransaction>(tx, `
        select * from wager_transactions
        where provider_id = $1 and external_transaction_id = $2
      `, [transaction.providerId, transaction.referenceExternalTransactionId]);
      reference = referenceRows[0];
      if (!reference) {
        return this.waitForReference(tx, row, transaction, wallet, context, now);
      }
      if (reference.id === row.id) {
        return this.reject(tx, row, transaction, wallet, 'INVALID_REFERENCE', context, now, reference.id);
      }
      if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
        return this.waitForReference(tx, row, transaction, wallet, context, now, reference.id);
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_PROCESSED', context, now, reference.id);
      }
      if (reference.player_id !== row.player_id
        || reference.wallet_id !== row.wallet_id
        || reference.currency !== row.currency
        || reference.round_id !== row.round_id) {
        return this.reject(tx, row, transaction, wallet, 'REFERENCE_CONTEXT_MISMATCH', context, now, reference.id);
      }
      if (transaction.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
        return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_BET', context, now, reference.id);
      }
      if (transaction.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
        return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_BET', context, now, reference.id);
      }
      if (transaction.kind === WagerTransactionKind.Rollback
        && ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)) {
        return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_REVERSIBLE', context, now, reference.id);
      }
      if (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback) {
        const referenceMoney = Money.from({ amount: reference.amount, currency: reference.currency });
        if (!transaction.money.equals(referenceMoney)) {
          return this.reject(tx, row, transaction, wallet, 'REFERENCE_AMOUNT_MISMATCH', context, now, reference.id);
        }
        const alreadyReversed = await rows<{ id: string }>(tx, `
          select id from wager_transactions
          where status = 'PROCESSED' and kind = $1 and reference_transaction_id = $2
          limit 1
        `, [transaction.kind, reference.id]);
        if (alreadyReversed.length > 0) {
          return this.reject(tx, row, transaction, wallet, 'ALREADY_REVERSED', context, now, reference.id);
        }
      }
      if (transaction.kind === WagerTransactionKind.Rollback) {
        const ledgerRows = await rows<DbLedger>(tx,
          'select * from wallet_ledger_entries where transaction_id = $1', [reference.id]);
        referenceLedger = ledgerRows[0];
        if (!referenceLedger) {
          return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_REVERSIBLE', context, now, reference.id);
        }
      }
    }

    let direction: LedgerDirection | undefined;
    if (transaction.kind === WagerTransactionKind.Bet) direction = LedgerDirection.Debit;
    else if (transaction.kind === WagerTransactionKind.Win || transaction.kind === WagerTransactionKind.Refund) direction = LedgerDirection.Credit;
    else if (transaction.kind === WagerTransactionKind.Rollback && referenceLedger) {
      direction = referenceLedger.direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
    }

    const balanceBefore = wallet.balance;
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
      const code: FailureCode = transaction.kind === WagerTransactionKind.Bet
        ? 'INSUFFICIENT_FUNDS'
        : 'REVERSAL_INSUFFICIENT_BALANCE';
      return this.reject(tx, row, transaction, wallet, code, context, now, reference?.id);
    }

    try {
      if (direction === LedgerDirection.Debit) wallet.debit(transaction.money, now);
      else if (direction === LedgerDirection.Credit) wallet.credit(transaction.money, now);
    } catch (error) {
      if (error instanceof Error && error.message === 'MONEY_AMOUNT_OUT_OF_RANGE') {
        return this.reject(tx, row, transaction, wallet, 'BALANCE_LIMIT_EXCEEDED', context, now, reference?.id);
      }
      throw error;
    }

    // Só operações com movimento financeiro geram ledger; a inserção e a alteração do saldo usam a mesma transação.
    if (direction) {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(), walletId: wallet.id, transactionId: row.id, direction,
        money: transaction.money, balanceBefore, balanceAfter: wallet.balance, createdAt: now,
      });
      await execute(tx, `
        insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.toJSON().amount,
        entry.money.currency, entry.balanceBefore.toJSON().amount, entry.balanceAfter.toJSON().amount, entry.createdAt,
      ]);
    }

    if (!balanceBefore.equals(wallet.balance)) {
      await execute(tx, `
        update wallets set balance_amount = $1, version = $2, updated_at = $3
        where id = $4 and version = $5
      `, [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id, walletRow.version]);
      const balanceEvent = WalletBalanceChanged.create({
        aggregateId: wallet.id,
        data: {
          walletId: wallet.id,
          transactionId: row.id,
          providerId: row.provider_id,
          direction: direction!,
          money: transaction.money.toJSON(),
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        },
        context: { correlationId: context.correlationId, causationId: context.messageId ?? row.id },
        occurredAt: now,
      });
      await this.outbox.enqueue(tx, balanceEvent);
    }

    transaction.markProcessed(reference?.id, now);
    await execute(tx, `
      update wager_transactions set status = 'PROCESSED', failure_code = null,
        reference_transaction_id = $1, processed_at = $2,
        response_balance_amount = $3, response_balance_currency = $4,
        reference_next_attempt_at = null
      where id = $5
    `, [reference?.id ?? null, now, wallet.balance.toJSON().amount, wallet.currency, row.id]);

    const processedEvent = WagerTransactionProcessed.create({
      aggregateId: row.id,
      data: {
        transactionId: row.id, providerId: row.provider_id, walletId: wallet.id,
        kind: row.kind, status: 'PROCESSED',
      },
      context: { correlationId: context.correlationId, causationId: context.messageId ?? row.id },
      occurredAt: now,
    });
    await this.outbox.enqueue(tx, processedEvent);

    return {
      transactionId: row.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async waitForReference(
    tx: EntityManager,
    row: DbWagerTransaction,
    transaction: WagerTransaction,
    wallet: Wallet,
    context: { correlationId: string; messageId?: string },
    now: Date,
    referenceTransactionId?: string,
  ): Promise<WagerResult> {
    const attempts = row.reference_attempts + 1;
    if (attempts >= MAX_REFERENCE_ATTEMPTS) {
      return this.reject(tx, row, transaction, wallet, 'REFERENCE_NOT_FOUND', context, now, referenceTransactionId);
    }

    transaction.markPendingReference();
    const delaySeconds = Math.min(2 ** Math.min(attempts - 1, 6), 60);
    const nextAttempt = new Date(now.getTime() + delaySeconds * 1000);
    await execute(tx, `
      update wager_transactions set status = 'PENDING_REFERENCE', failure_code = null,
        reference_transaction_id = $1, reference_attempts = $2,
        reference_next_attempt_at = $3,
        response_balance_amount = $4, response_balance_currency = $5
      where id = $6
    `, [referenceTransactionId ?? null, attempts, nextAttempt, wallet.balance.toJSON().amount, wallet.currency, row.id]);

    const event = WagerTransactionPendingReference.create({
      aggregateId: row.id,
      data: {
        transactionId: row.id,
        providerId: row.provider_id,
        walletId: wallet.id,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? '',
      },
      context: { correlationId: context.correlationId, causationId: context.messageId ?? row.id },
      occurredAt: now,
    });
    await this.outbox.enqueue(tx, event);
    return {
      transactionId: row.id,
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async reject(
    tx: EntityManager,
    row: DbWagerTransaction,
    transaction: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    context: { correlationId: string; messageId?: string },
    now: Date,
    referenceTransactionId?: string,
  ): Promise<WagerResult> {
    transaction.reject(failureCode);
    await execute(tx, `
      update wager_transactions set status = 'REJECTED', failure_code = $1,
        reference_transaction_id = $2, processed_at = $3,
        response_balance_amount = $4, response_balance_currency = $5,
        reference_next_attempt_at = null
      where id = $6
    `, [failureCode, referenceTransactionId ?? null, now, wallet.balance.toJSON().amount, wallet.currency, row.id]);
    const rejectedEvent = WagerTransactionRejected.create({
      aggregateId: row.id,
      data: {
        transactionId: row.id, providerId: row.provider_id, walletId: wallet.id,
        kind: row.kind, failureCode,
      },
      context: { correlationId: context.correlationId, causationId: context.messageId ?? row.id },
      occurredAt: now,
    });
    await this.outbox.enqueue(tx, rejectedEvent);
    return {
      transactionId: row.id,
      status: WagerTransactionStatus.Rejected,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode,
    };
  }

  private resultFromStored(row: DbWagerTransaction, idempotentReplay: boolean): WagerResult {
    const balance = row.response_balance_amount ?? '0.00';
    const currency = row.response_balance_currency ?? row.currency;
    return {
      transactionId: row.id,
      status: row.status,
      balance: { amount: new Decimal(balance).toFixed(2), currency },
      idempotentReplay,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };
  }

  private inputFromRow(row: DbWagerTransaction): SubmitWagerTransactionDto {
    return {
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      playerId: row.player_id,
      walletId: row.wallet_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as SubmitWagerTransactionDto['kind'],
      money: { amount: row.amount, currency: row.currency },
      ...(row.reference_external_transaction_id ? { referenceExternalTransactionId: row.reference_external_transaction_id } : {}),
    };
  }

  private serializeTransaction(row: DbWagerTransaction): Record<string, unknown> {
    return {
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: { amount: new Decimal(row.amount).toFixed(2), currency: row.currency },
      ...(row.reference_external_transaction_id ? { referenceExternalTransactionId: row.reference_external_transaction_id } : {}),
      ...(row.reference_transaction_id ? { referenceTransactionId: row.reference_transaction_id } : {}),
      status: row.status,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      ...(row.processed_at ? { processedAt: toDate(row.processed_at).toISOString() } : {}),
      createdAt: toDate(row.created_at).toISOString(),
      ...(row.response_balance_amount !== null && row.response_balance_amount !== undefined ? {
        response: {
          balance: { amount: new Decimal(row.response_balance_amount).toFixed(2), currency: row.response_balance_currency ?? row.currency },
        },
      } : {}),
    };
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isLockConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: string }).code;
  return code === '40P01' || code === '40001';
}
