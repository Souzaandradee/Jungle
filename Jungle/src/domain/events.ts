import { randomUUID } from 'node:crypto';
import { MoneyProps } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

// O agregado é o recurso ao qual o evento se refere; pode ser uma wallet ou uma transação.
// Não se deve inferir transactionId a partir de aggregateId sem verificar os dados do evento.
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Readonly<T>;
}

export interface IntegrationEventCreateProps<T> {
  aggregateId: string;
  data: T;
  context: EventContext;
  occurredAt?: Date;
}

export abstract class IntegrationEvent<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;
  abstract readonly eventType: string;
  abstract readonly version: number;

  protected constructor(props: IntegrationEventCreateProps<T>) {
    // O envelope será persistido na outbox; o eventId acompanha eventuais redeliveries para deduplicação.
    this.eventId = randomUUID();
    this.aggregateId = props.aggregateId;
    this.correlationId = props.context.correlationId;
    this.causationId = props.context.causationId;
    this.occurredAt = props.occurredAt ?? new Date();
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: string;
  status: 'PROCESSED';
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventCreateProps<WagerTransactionProcessedData>) { super(props); }
  static create(props: IntegrationEventCreateProps<WagerTransactionProcessedData>): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: string;
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventCreateProps<WagerTransactionRejectedData>) { super(props); }
  static create(props: IntegrationEventCreateProps<WagerTransactionRejectedData>): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  walletId: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventCreateProps<WagerTransactionPendingReferenceData>) { super(props); }
  static create(props: IntegrationEventCreateProps<WagerTransactionPendingReferenceData>): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  providerId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventCreateProps<WalletBalanceChangedData>) { super(props); }
  static create(props: IntegrationEventCreateProps<WalletBalanceChangedData>): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}
