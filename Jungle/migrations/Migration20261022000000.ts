import { Migration } from '@mikro-orm/migrations';

export class Migration20261022000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function is_iso4217_currency(code text) returns boolean
      language sql immutable parallel safe
      as $$ select rtrim(code) = any (array['AED', 'AFN', 'ALL', 'AMD', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XCG', 'XDR', 'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XUA', 'YER', 'ZAR', 'ZMW', 'ZWG']::text[]) $$;

      create table "wallets" (
        "id" uuid primary key,
        "player_id" uuid not null,
        "currency" char(3) not null check (is_iso4217_currency("currency"::text)),
        "balance_amount" numeric(20,2) not null check ("balance_amount" >= 0),
        "version" integer not null check ("version" >= 1),
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_player_currency_uq" unique ("player_id", "currency")
      );

      create table "wager_transactions" (
        "id" uuid primary key,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null unique,
        "payload_hash" char(64) not null,
        "wallet_id" uuid not null references "wallets"("id"),
        "player_id" uuid not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" text not null check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        "amount" numeric(20,2) not null check ("amount" >= 0),
        "currency" char(3) not null check (is_iso4217_currency("currency"::text)),
        "reference_external_transaction_id" text,
        "reference_transaction_id" uuid references "wager_transactions"("id"),
        "status" text not null check ("status" in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        "failure_code" text,
        "processed_at" timestamptz,
        "response_balance_amount" numeric(20,2) check ("response_balance_amount" >= 0),
        "response_balance_currency" char(3) check ("response_balance_currency" is null or is_iso4217_currency("response_balance_currency"::text)),
        "reference_attempts" integer not null default 0 check ("reference_attempts" >= 0),
        "reference_next_attempt_at" timestamptz,
        "created_at" timestamptz not null
      );
      create unique index "wager_transactions_provider_external_uq"
        on "wager_transactions" ("provider_id", "external_transaction_id");
      create index "wager_transactions_pending_reference_idx"
        on "wager_transactions" ("reference_next_attempt_at", "created_at")
        where "status" = 'PENDING_REFERENCE';
      create unique index "wager_transactions_one_processed_reversal_uq"
        on "wager_transactions" ("kind", "reference_transaction_id")
        where "status" = 'PROCESSED' and "kind" in ('REFUND','ROLLBACK');

      create table "wallet_ledger_entries" (
        "id" uuid primary key,
        "wallet_id" uuid not null references "wallets"("id"),
        "transaction_id" uuid not null unique references "wager_transactions"("id"),
        "direction" text not null check ("direction" in ('DEBIT','CREDIT')),
        "amount" numeric(20,2) not null check ("amount" >= 0),
        "currency" char(3) not null check (is_iso4217_currency("currency"::text)),
        "balance_before" numeric(20,2) not null check ("balance_before" >= 0),
        "balance_after" numeric(20,2) not null check ("balance_after" >= 0),
        "created_at" timestamptz not null,
        constraint "ledger_arithmetic_ck" check (
          ("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after") or
          ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")
        )
      );
      create index "wallet_ledger_wallet_cursor_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);

      -- Este trigger por linha protege UPDATE/DELETE; TRUNCATE é uma operação distinta e exige proteção própria.
      create function "prevent_wallet_ledger_mutation"() returns trigger as $$
      begin
        raise exception 'wallet ledger entries are immutable' using errcode = '55000';
      end;
      $$ language plpgsql;
      create trigger "wallet_ledger_immutable_trg"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "prevent_wallet_ledger_mutation"();

      create table "inbox_messages" (
        "consumer_name" text not null,
        "message_id" text not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz,
        primary key ("consumer_name", "message_id")
      );

      create table "outbox_messages" (
        "id" uuid primary key,
        "aggregate_id" text not null,
        "event_type" text not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0 check ("attempts" >= 0),
        "next_attempt_at" timestamptz,
        "published_at" timestamptz,
        "created_at" timestamptz not null
      );
      create index "outbox_pending_idx"
        on "outbox_messages" ("next_attempt_at", "created_at")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table if exists "outbox_messages";
      drop table if exists "inbox_messages";
      drop trigger if exists "wallet_ledger_immutable_trg" on "wallet_ledger_entries";
      drop function if exists "prevent_wallet_ledger_mutation"();
      drop table if exists "wallet_ledger_entries";
      drop table if exists "wager_transactions";
      drop table if exists "wallets";
      drop function if exists is_iso4217_currency(text);
    `);
  }
}
