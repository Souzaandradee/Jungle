import { Module } from '@nestjs/common';
import { DatabaseModule } from './infra/database/database.module';
import { OutboxWriter } from './infra/database/outbox-writer';
import { NoopProviderIdentityAdapter } from './infra/auth/noop-provider-identity.adapter';
import { PROVIDER_IDENTITY_PORT } from './infra/auth/provider-identity.port';
import { StructuredLogger } from './infra/logging/structured-logger';
import { MetricsController } from './infra/metrics/metrics.controller';
import { MetricsService } from './infra/metrics/metrics.service';
import { SqsClientService } from './infra/sqs/sqs-client.service';
import { SqsWorkerService } from './infra/sqs/sqs-worker.service';
import { OutboxPublisherService } from './infra/sqs/outbox-publisher.service';
import { HealthController } from './health/health.controller';
import { WalletsController } from './wallets/wallets.controller';
import { WalletsService } from './wallets/wallets.service';
import { WageringController } from './wagering/wagering.controller';
import { WageringService } from './wagering/wagering.service';
import { PendingReferenceWorkerService } from './wagering/pending-reference-worker.service';

@Module({
  imports: [DatabaseModule],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    WalletsService,
    WageringService,
    OutboxWriter,
    StructuredLogger,
    MetricsService,
    SqsClientService,
    SqsWorkerService,
    OutboxPublisherService,
    PendingReferenceWorkerService,
    NoopProviderIdentityAdapter,
    { provide: PROVIDER_IDENTITY_PORT, useExisting: NoopProviderIdentityAdapter },
  ],
})
export class AppModule {}
