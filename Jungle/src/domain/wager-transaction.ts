import { LedgerDirection } from './wallet-ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_BALANCE'
  | 'BALANCE_LIMIT_EXCEEDED'
  | 'WALLET_PLAYER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_CONTEXT_MISMATCH'
  | 'REFERENCE_NOT_BET'
  | 'REFERENCE_NOT_REVERSIBLE'
  | 'ALREADY_REVERSED'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'INVALID_REFERENCE';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode | string;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode | string,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.idempotencyKey.trim()) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
    if (!props.providerId.trim() || !props.externalTransactionId.trim()) throw new Error('PROVIDER_TRANSACTION_ID_REQUIRED');
    if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback)
      && !props.referenceExternalTransactionId?.trim()) {
      throw new Error('REFERENCE_REQUIRED');
    }
    if (props.kind === WagerTransactionKind.Opening) throw new Error('OPENING_IS_INTERNAL');
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt ?? new Date(),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | string | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode | string): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode | string): void {
    this.assertNonTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: { kind: WagerTransactionKind; ledgerDirection?: LedgerDirection }): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference?.ledgerDirection) return undefined;
        return reference.ledgerDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Opening:
        return undefined;
    }
  }

  private assertNonTerminal(): void {
    if (this.isTerminal()) throw new Error('INVALID_TRANSACTION_STATE');
  }
}
