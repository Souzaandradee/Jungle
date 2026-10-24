import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SqsClientService } from './sqs-client.service';
import { WageringService } from '../../wagering/wagering.service';
import { StructuredLogger } from '../logging/structured-logger';
import { MetricsService } from '../metrics/metrics.service';
import { Money } from '../../domain/money';

interface WagerRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

const MAX_RECEIVE_ATTEMPTS = 4;
const TEST_FAULTS_ENABLED = process.env.ENABLE_TEST_FAULT_INJECTION === '1';

@Injectable()
export class SqsWorkerService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly sqs: SqsClientService,
    private readonly wagering: WageringService,
    private readonly logger: StructuredLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.sqs.transactionsQueueUrl) return;
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    // Let the active batch finish. Messages that have not started are returned to the queue.
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.sqs.receive(this.sqs.transactionsQueueUrl);
        const messages = result.Messages ?? [];
        if (!this.running) {
          await Promise.all(messages
            .filter((message) => Boolean(message.ReceiptHandle))
            .map((message) => this.sqs.retryLater(this.sqs.transactionsQueueUrl, message.ReceiptHandle!, 0)));
          continue;
        }

        // SQS FIFO delivers a group in order. Process different groups concurrently,
        // but preserve sequential processing inside each MessageGroupId (walletId).
        await this.processBatch(messages);
        await this.updateDlqMetric();
      } catch (error) {
        this.logger.error('sqs_poll_failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
        await delay(1000);
      }
    }
  }

  private async processBatch(messages: NonNullable<Awaited<ReturnType<SqsClientService['receive']>>['Messages']>): Promise<void> {
    const groups = new Map<string, typeof messages>();
    for (const message of messages) {
      const groupId = message.Attributes?.MessageGroupId ?? '__unknown_fifo_group__';
      const group = groups.get(groupId) ?? [];
      group.push(message);
      groups.set(groupId, group);
    }

    await Promise.all([...groups.entries()].map(async ([groupId, group]) => {
      for (const message of group) {
        if (!message.ReceiptHandle) continue;
        if (!this.running) {
          await this.sqs.retryLater(this.sqs.transactionsQueueUrl, message.ReceiptHandle, 0);
          continue;
        }
        try {
          await this.handleMessage(
            message.Body ?? '',
            message.ReceiptHandle,
            this.sqs.transactionsQueueUrl,
            message.Attributes?.ApproximateReceiveCount,
            message.MessageId,
            groupId === '__unknown_fifo_group__' ? undefined : groupId,
          );
        } catch (error) {
          // A broker/network failure must leave the message unacknowledged for redelivery.
          this.logger.error('sqs_message_handler_failed', {
            messageId: message.MessageId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          try {
            await this.sqs.retryLater(this.sqs.transactionsQueueUrl, message.ReceiptHandle, retryDelay(message.Attributes?.ApproximateReceiveCount));
          } catch {
            // The visibility timeout already provides a fallback when SQS is unavailable.
          }
        }
      }
    }));
  }

  private async handleMessage(
    body: string,
    receiptHandle: string,
    queueUrl: string,
    receiveCount?: string,
    sqsMessageId?: string,
    messageGroupId?: string,
  ): Promise<void> {
    const attempts = receiveAttempts(receiveCount);
    let message: WagerRequestedMessage;
    try {
      message = JSON.parse(body) as WagerRequestedMessage;
      validateMessage(message);
    } catch (error) {
      await this.moveToDlq({
        body, receiptHandle, queueUrl, sqsMessageId, messageGroupId,
        receiveCount, reason: `INVALID_MESSAGE:${error instanceof Error ? error.message : 'UNKNOWN'}`,
      });
      return;
    }

    try {
      // Explicit, opt-in fault hooks exercise the same bounded retry/DLQ path as real outages.
      // They are disabled unless ENABLE_TEST_FAULT_INJECTION=1 is set on the container.
      if (this.shouldInjectTransientFailure(message.messageId, attempts)) {
        throw Object.assign(new Error('Injected transient SQS failure.'), { code: 'ECONNRESET' });
      }
      if (this.shouldExhaustRetries(message.messageId)) {
        throw Object.assign(new Error('Injected persistent transient SQS failure.'), { code: 'ECONNRESET' });
      }

      // O mesmo caso de uso valida e persiste a mensagem; o ACK só pode ocorrer depois do commit bem-sucedido.
      const outcome = await this.wagering.submit(message.data, message.data.idempotencyKey, {
        messageId: message.messageId,
        consumerName: 'wager-transactions-consumer',
        correlationId: message.messageId,
      });

      if (outcome.status === 'REJECTED') {
        // Business rejection is persisted and emitted by the shared use case: it is terminal,
        // so acknowledge it rather than retrying a message that cannot succeed unchanged.
        this.logger.warn('sqs_business_transaction_rejected', {
          messageId: message.messageId,
          providerId: message.data.providerId,
          walletId: message.data.walletId,
          transactionId: outcome.transactionId,
          failureCode: outcome.failureCode,
        });
      }

      if (this.shouldCrashAfterCommitBeforeAck(message.messageId, attempts)) {
        this.logger.error('sqs_test_crash_after_commit_before_ack', {
          messageId: message.messageId,
          transactionId: outcome.transactionId,
          walletId: message.data.walletId,
        });
        // Make redelivery prompt, then terminate the process without deleting the message.
        // The financial transaction and inbox record have already committed.
        await this.sqs.retryLater(queueUrl, receiptHandle, 0);
        process.exit(86);
      }

      // The financial write and persistent inbox have committed before this ACK.
      await this.sqs.ack(queueUrl, receiptHandle);
    } catch (error) {
      if (isTransientFailure(error)) {
        if (attempts >= MAX_RECEIVE_ATTEMPTS) {
          await this.moveToDlq({
            body, receiptHandle, queueUrl, sqsMessageId, messageGroupId,
            receiveCount, reason: 'TRANSIENT_RETRY_LIMIT_EXCEEDED',
          });
          return;
        }

        this.metrics.recordRetry('sqs');
        this.logger.warn('sqs_message_retry_scheduled', {
          messageId: message.messageId,
          providerId: message.data.providerId,
          walletId: message.data.walletId,
          receiveCount: attempts,
          errorName: error instanceof Error ? error.name : 'ProcessingError',
        });
        await this.sqs.retryLater(queueUrl, receiptHandle, retryDelay(receiveCount));
        return;
      }

      // Malformed requests, invalid references to unknown entities, conflicts and unexpected
      // non-transient failures cannot be repaired by retrying unchanged input: preserve them in DLQ.
      await this.moveToDlq({
        body, receiptHandle, queueUrl, sqsMessageId, messageGroupId,
        receiveCount, reason: `PERMANENT_FAILURE:${safeErrorCode(error)}`,
      });
    }
  }

  private shouldInjectTransientFailure(messageId: string, attempts: number): boolean {
    return TEST_FAULTS_ENABLED && messageId.startsWith('test-transient-retry:') && attempts < 3;
  }

  private shouldExhaustRetries(messageId: string): boolean {
    return TEST_FAULTS_ENABLED && messageId.startsWith('test-transient-exhaust:');
  }

  private shouldCrashAfterCommitBeforeAck(messageId: string, attempts: number): boolean {
    return TEST_FAULTS_ENABLED && messageId.startsWith('test-crash-before-ack:') && attempts === 1;
  }

  private async moveToDlq(args: {
    body: string;
    receiptHandle: string;
    queueUrl: string;
    sqsMessageId?: string;
    messageGroupId?: string;
    receiveCount?: string;
    reason: string;
  }): Promise<void> {
    if (!this.sqs.dlqQueueUrl) {
      this.metrics.recordRetry('sqs');
      await this.sqs.retryLater(args.queueUrl, args.receiptHandle, retryDelay(args.receiveCount));
      return;
    }

    const deduplicationId = args.sqsMessageId
      ?? createHash('sha256').update(args.body).digest('hex');
    const deadLetter = JSON.stringify({
      sourceMessageId: args.sqsMessageId ?? null,
      reason: args.reason,
      failedAt: new Date().toISOString(),
      originalBody: args.body,
    });

    try {
      await this.sqs.send(
        this.sqs.dlqQueueUrl,
        deadLetter,
        args.messageGroupId ?? 'unassigned',
        deduplicationId,
      );
      this.logger.warn('sqs_message_sent_to_dlq', {
        messageId: args.sqsMessageId,
        receiveCount: receiveAttempts(args.receiveCount),
        reason: args.reason,
      });
      await this.sqs.ack(args.queueUrl, args.receiptHandle);
    } catch (error) {
      // Never delete the source message unless the DLQ send succeeded.
      this.logger.error('sqs_dlq_forward_failed', {
        messageId: args.sqsMessageId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await this.sqs.retryLater(args.queueUrl, args.receiptHandle, retryDelay(args.receiveCount));
    }
  }

  private async updateDlqMetric(): Promise<void> {
    if (!this.sqs.dlqQueueUrl) return;
    try {
      const attributes = await this.sqs.attributes(this.sqs.dlqQueueUrl);
      this.metrics.recordDlqMessages(Number(attributes.ApproximateNumberOfMessages ?? 0));
    } catch {
      // Readiness reports dependency failures. Metrics collection must not stop consumption.
    }
  }
}

function validateMessage(value: WagerRequestedMessage): void {
  if (!value || typeof value !== 'object' || value.type !== 'WagerTransactionRequested') throw new Error('INVALID_MESSAGE_TYPE');
  if (typeof value.messageId !== 'string' || !value.messageId.trim() || value.messageId.length > 256) throw new Error('MESSAGE_ID_REQUIRED');
  if (typeof value.occurredAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt))) {
    throw new Error('INVALID_OCCURRED_AT');
  }
  if (!value.data || typeof value.data !== 'object') throw new Error('MESSAGE_DATA_REQUIRED');

  const fieldLimits = {
    providerId: 128,
    externalTransactionId: 256,
    idempotencyKey: 512,
    roundId: 256,
    gameId: 256,
  } as const;
  for (const [field, maxLength] of Object.entries(fieldLimits) as [keyof typeof fieldLimits, number][]) {
    const valueForField = value.data[field];
    if (typeof valueForField !== 'string' || !valueForField.trim() || valueForField.length > maxLength) {
      throw new Error(`INVALID_${field.toUpperCase()}`);
    }
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value.data.playerId !== 'string' || !uuid.test(value.data.playerId)) throw new Error('INVALID_PLAYER_ID');
  if (typeof value.data.walletId !== 'string' || !uuid.test(value.data.walletId)) throw new Error('INVALID_WALLET_ID');
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(value.data.kind)) throw new Error('INVALID_TRANSACTION_KIND');
  if (!value.data.money || typeof value.data.money.amount !== 'string' || typeof value.data.money.currency !== 'string') {
    throw new Error('INVALID_MONEY');
  }
  Money.from(value.data.money);
  if (value.data.referenceExternalTransactionId !== undefined
    && (typeof value.data.referenceExternalTransactionId !== 'string'
      || !value.data.referenceExternalTransactionId.trim()
      || value.data.referenceExternalTransactionId.length > 256)) {
    throw new Error('INVALID_REFERENCE_EXTERNAL_TRANSACTION_ID');
  }
}

function exceptionStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('getStatus' in error)) return undefined;
  try { return (error as { getStatus: () => number }).getStatus(); } catch { return undefined; }
}

function isTransientFailure(error: unknown): boolean {
  const status = exceptionStatus(error);
  if (status !== undefined) {
    if ([408, 425, 429].includes(status)) return true;
    if (status >= 500 && ![501, 505].includes(status)) return true;
    return false;
  }

  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current) {
      const code = String((current as { code?: unknown }).code ?? '');
      if (code.startsWith('08') || code.startsWith('53') || code.startsWith('57P') || code.startsWith('400') || code.startsWith('40P') || [
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
        'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED', '53300', '429', 'ThrottlingException',
        'RequestTimeout', 'TimeoutError', 'ServiceUnavailable', 'InternalError', 'SlowDown',
      ].includes(code)) return true;
      // SQL data/integrity/syntax errors will not be fixed by retrying identical input.
      if (code.startsWith('22') || code.startsWith('23') || code.startsWith('42') || code === 'P0001' || code === '42501') {
        return false;
      }
    }
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }

  // Unknown infrastructure/runtime errors get bounded retries and are then sent to DLQ.
  return true;
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code).slice(0, 80);
  }
  const status = exceptionStatus(error);
  return status === undefined ? (error instanceof Error ? error.name : 'UNKNOWN') : `HTTP_${status}`;
}

function receiveAttempts(receiveCount?: string): number {
  const parsed = Number(receiveCount ?? 1);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function retryDelay(receiveCount?: string): number {
  const attempts = receiveAttempts(receiveCount);
  return Math.min(2 ** Math.min(attempts, 6), 60);
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
