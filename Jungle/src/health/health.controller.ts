import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { SqsClientService } from '../infra/sqs/sqs-client.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientService,
  ) {}

  @Get('live')
  live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try {
      await this.em.getConnection().execute('select 1');
      if (!this.sqs.transactionsQueueUrl || !this.sqs.dlqQueueUrl || !this.sqs.eventsQueueUrl) {
        throw new Error('SQS queue URLs are not configured.');
      }
      await Promise.all([
        this.sqs.attributes(this.sqs.transactionsQueueUrl),
        this.sqs.attributes(this.sqs.dlqQueueUrl),
        this.sqs.attributes(this.sqs.eventsQueueUrl),
      ]);
      return { status: 'ready', dependencies: { postgres: 'ok', sqs: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready', dependencies: { postgres: 'unknown', sqs: 'unknown' },
      });
    }
  }
}
