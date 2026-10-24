import { Type } from 'class-transformer';
import { ISO_4217_CURRENCY_CODES } from '../domain/currency';
import {
  IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested,
} from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^\d{1,18}\.\d{2}$/)
  amount!: string;

  @IsString()
  @IsIn([...ISO_4217_CURRENCY_CODES])
  currency!: string;
}

export class SubmitWagerTransactionDto {
  @IsString() @Length(1, 128)
  providerId!: string;

  @IsString() @Length(1, 256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString() @Length(1, 256)
  roundId!: string;

  @IsString() @Length(1, 256)
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional() @IsString() @Length(1, 256)
  referenceExternalTransactionId?: string;
}
