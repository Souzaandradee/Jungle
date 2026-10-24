import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './wallets.dto';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  create(@Body() dto: CreateWalletDto) { return this.wallets.create(dto); }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) { return this.wallets.ledger(walletId, cursor, limit); }

  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) { return this.wallets.reconcile(walletId); }

  @Get(':walletId')
  get(@Param('walletId', new ParseUUIDPipe()) walletId: string) { return this.wallets.get(walletId); }
}
