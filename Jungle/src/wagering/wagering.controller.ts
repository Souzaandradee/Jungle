import { Body, BadRequestException, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { WageringService } from './wagering.service';
import { SubmitWagerTransactionDto } from './wagering.dto';

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wagering/transactions')
  async submit(
    @Body() dto: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required.');
    const correlationId = correlationHeader?.slice(0, 128) || randomUUID();
    const result = await this.wagering.submit(dto, idempotencyKey, { correlationId });
    if (result.status === 'REJECTED') response.status(422);
    else if (result.status === 'PENDING_REFERENCE') response.status(202);
    else response.status(200);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    return this.wagering.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByProviderId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wagering.getByProviderTransaction(providerId, externalTransactionId);
  }
}
