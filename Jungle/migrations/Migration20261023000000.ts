import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      -- Row-level UPDATE/DELETE triggers do not intercept TRUNCATE.
      -- A statement-level trigger is required to keep the ledger immutable.
      create trigger "wallet_ledger_no_truncate_trg"
        before truncate on "wallet_ledger_entries"
        for each statement execute function "prevent_wallet_ledger_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists "wallet_ledger_no_truncate_trg" on "wallet_ledger_entries";
    `);
  }
}
