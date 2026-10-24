import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsClientService implements OnApplicationShutdown {
  readonly client: SQSClient;
  readonly transactionsQueueUrl: string;
  readonly dlqQueueUrl: string;
  readonly eventsQueueUrl: string;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'sa-east-1',
      endpoint: process.env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    this.transactionsQueueUrl = process.env.SQS_TRANSACTIONS_QUEUE_URL ?? '';
    this.dlqQueueUrl = process.env.SQS_DLQ_QUEUE_URL ?? '';
    this.eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? '';
  }

  // Keep the shared client alive while workers finish/return in-flight messages during onModuleDestroy.
  onApplicationShutdown(): void { this.client.destroy(); }

  async send(queueUrl: string, body: string, groupId?: string, deduplicationId?: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      ...(queueUrl.endsWith('.fifo') ? {
        MessageGroupId: groupId ?? 'wagering',
        MessageDeduplicationId: deduplicationId,
      } : {}),
    }));
  }

  async receive(queueUrl: string) {
    return this.client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 10,
      VisibilityTimeout: Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      MessageAttributeNames: ['All'],
    }));
  }

  async ack(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  async retryLater(queueUrl: string, receiptHandle: string, seconds = 10): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds,
    }));
  }

  async attributes(queueUrl: string): Promise<Record<string, string>> {
    const result = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'QueueArn'],
    }));
    return result.Attributes ?? {};
  }
}
