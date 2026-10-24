import { expect, mock, test } from 'bun:test';
import type { SqsClientService } from '../../src/infra/sqs/sqs-client.service';
import type { WageringService } from '../../src/wagering/wagering.service';
import type { StructuredLogger } from '../../src/infra/logging/structured-logger';
import type { MetricsService } from '../../src/infra/metrics/metrics.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function queueMessage(messageId: string, receiptHandle: string) {
  return {
    MessageId: messageId,
    ReceiptHandle: receiptHandle,
    Body: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: {
        providerId: 'unit-provider',
        externalTransactionId: 'external-' + messageId,
        idempotencyKey: 'idempotency-' + messageId,
        playerId: '11111111-1111-4111-8111-111111111111',
        walletId: '22222222-2222-4222-8222-222222222222',
        roundId: 'round-' + messageId,
        gameId: 'unit-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    }),
    Attributes: {
      MessageGroupId: '22222222-2222-4222-8222-222222222222',
      ApproximateReceiveCount: '1',
    },
  };
}

test('worker shutdown waits for the active message and returns not-yet-started messages to SQS', async () => {
  mock.module('../../src/wagering/wagering.service', () => ({ WageringService: class WageringService {} }));
  const { SqsWorkerService } = await import('../../src/infra/sqs/sqs-worker.service');
  const submitStarted = deferred<void>();
  const submitResult = deferred<{ status: string; transactionId: string }>();
  const acked: string[] = [];
  const visibilityChanges: Array<{ receiptHandle: string; seconds: number }> = [];
  let receiveCalls = 0;
  let submitCalls = 0;

  const sqs = {
    transactionsQueueUrl: 'transactions-queue',
    dlqQueueUrl: '',
    receive: async () => {
      receiveCalls += 1;
      return {
        Messages: [
          queueMessage('shutdown-active-message', 'receipt-active'),
          queueMessage('shutdown-pending-message', 'receipt-pending'),
        ],
      };
    },
    ack: async (_queueUrl: string, receiptHandle: string) => { acked.push(receiptHandle); },
    retryLater: async (_queueUrl: string, receiptHandle: string, seconds: number) => {
      visibilityChanges.push({ receiptHandle, seconds });
    },
  };

  const wagering = {
    submit: async () => {
      submitCalls += 1;
      submitStarted.resolve();
      return submitResult.promise;
    },
  };

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const metrics = {
    recordStatus: () => {},
    recordDuplicate: () => {},
    recordRetry: () => {},
    recordDlqMessages: () => {},
    recordLockConflict: () => {},
    observeProcessing: () => {},
    recordOutboxLag: () => {},
    recordReconciliationMismatch: () => {},
  };

  const worker = new SqsWorkerService(
    sqs as unknown as SqsClientService,
    wagering as unknown as WageringService,
    logger as unknown as StructuredLogger,
    metrics as unknown as MetricsService,
  );

  worker.onModuleInit();
  await submitStarted.promise;

  let destroyFinished = false;
  const destroying = worker.onModuleDestroy().then(() => { destroyFinished = true; });
  await Promise.resolve();
  expect(destroyFinished).toBe(false);

  submitResult.resolve({ status: 'PROCESSED', transactionId: 'transaction-active' });
  await destroying;

  expect(submitCalls).toBe(1);
  expect(acked).toEqual(['receipt-active']);
  expect(visibilityChanges).toEqual([{ receiptHandle: 'receipt-pending', seconds: 0 }]);
  expect(receiveCalls).toBe(1);
});
