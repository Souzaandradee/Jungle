import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Minimal persistence mapping for MikroORM metadata; write paths use explicit SQL for locking/constraints. */
@Entity({ tableName: 'wallets' })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_amount', type: 'decimal', precision: 20, scale: 2 })
  balanceAmount!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ fieldName: 'created_at', type: Date })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: Date })
  updatedAt!: Date;
}
