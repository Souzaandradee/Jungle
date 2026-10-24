import { normalizeSql } from '../../src/infra/database/sql';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WalletRecord } from '../../src/infra/database/wallet.record';
import ormConfig from '../../src/infra/database/mikro-orm.config';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const enabled = process.env.RUN_INTEGRATION === '1';
const baseUrls = (process.env.API_BASE_URLS ?? process.env.API_BASE_URL ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002')
  .split(',').map((url) => url.trim()).filter(Boolean);
let nextBaseUrlIndex = 0;
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const transactionsQueueUrl = process.env.SQS_TRANSACTIONS_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`;
const deadLetterQueueUrl = process.env.SQS_DLQ_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`;
const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? `${endpoint}/000000000000/wager-events.fifo`;
const localCompose = !process.env.API_BASE_URL && !process.env.API_BASE_URLS;
let database: MikroORM | undefined;
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'sa-east-1',
  endpoint,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
});

beforeAll(async () => {
  if (!enabled) return;
  database = await MikroORM.init({
    driver: PostgreSqlDriver,
    entities: [WalletRecord],
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    dbName: process.env.DATABASE_NAME ?? 'wagering',
    user: process.env.DATABASE_USER ?? 'wagering',
    password: process.env.DATABASE_PASSWORD ?? 'wagering',
  });
});

afterAll(async () => {
  await database?.close(true);
  sqs.destroy();
});

if (!enabled) {
  test.skip('Integration tests require Docker Compose services and RUN_INTEGRATION=1', () => {});
} else {
  test('liveness and readiness endpoints are available on every API instance', async () => {
    for (const url of baseUrls) {
      const liveness = await fetch(url + '/health/live');
      expect(liveness.ok).toBe(true);
      const readiness = await fetch(url + '/health/ready');
      expect(readiness.ok).toBe(true);
    }
  });

  test('the same wager submitted 50 times concurrently creates one debit', async () => {
    const wallet = await createWallet('500.00');
    const body = wager(wallet, { amount: '10.00', kind: 'BET' });
    const key = `integration:${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 50 }, () => postWager(body, key)));
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<any>));

    expect(payloads.every((value) => value.transactionId === payloads[0].transactionId)).toBe(true);
    expect(payloads.filter((value) => value.idempotentReplay === false)).toHaveLength(1);
    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a player cannot have two wallets with the same currency', async () => {
    const wallet = await createWallet('100.00');
    const duplicate = await fetch(`${nextBaseUrl()}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: wallet.playerId,
        initialBalance: { amount: '25.00', currency: 'BRL' },
      }),
    });
    expect(duplicate.status).toBe(409);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
  });

  test('reusing an Idempotency-Key with a different payload is a conflict', async () => {
    const wallet = await createWallet('100.00');
    const body = wager(wallet, { amount: '10.00', kind: 'BET' });
    const key = `conflict:${randomUUID()}`;
    expect((await postWager(body, key)).status).toBe(200);

    const changedBody = { ...body, money: { amount: '11.00', currency: 'BRL' } };
    const conflict = await postWager(changedBody, key);
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).message).toContain('different business payload');

    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('90.00');
  });

  test('LOSS and a currency mismatch do not create ledger entries or change the balance', async () => {
    const wallet = await createWallet('100.00');
    const loss = wager(wallet, { amount: '10.00', kind: 'LOSS' });
    expect((await postWager(loss, `loss:${randomUUID()}`)).status).toBe(200);

    const wrongCurrency = {
      ...wager(wallet, { amount: '1.00', kind: 'BET' }),
      money: { amount: '1.00', currency: 'USD' },
    };
    const rejection = await postWager(wrongCurrency, `currency:${randomUUID()}`);
    expect(rejection.status).toBe(422);
    expect((await rejection.json() as any).failureCode).toBe('CURRENCY_MISMATCH');

    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items).toHaveLength(1); // Opening credit only.
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('different wallets can process transactions concurrently', async () => {
    const [firstWallet, secondWallet] = await Promise.all([
      createWallet('100.00'),
      createWallet('100.00'),
    ]);
    const [firstResponse, secondResponse] = await Promise.all([
      postWager(wager(firstWallet, { amount: '30.00', kind: 'BET' }), `wallet-a:${randomUUID()}`),
      postWager(wager(secondWallet, { amount: '40.00', kind: 'BET' }), `wallet-b:${randomUUID()}`),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect((await getJson(`/wallets/${firstWallet.id}`)).balance.amount).toBe('70.00');
    expect((await getJson(`/wallets/${secondWallet.id}`)).balance.amount).toBe('60.00');
    expect((await getJson(`/wallets/${firstWallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    expect((await getJson(`/wallets/${secondWallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('ledger cursor pagination is stable across pages with no missing or duplicate entries', async () => {
    const wallet = await createWallet('100.00');
    const expectedDebits = 5;
    for (let index = 0; index < expectedDebits; index += 1) {
      const request = wager(wallet, { amount: '1.00', kind: 'BET' });
      expect((await postWager(request, 'cursor:' + randomUUID())).status).toBe(200);
    }
    const seen = [] as any[];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const path = '/wallets/' + wallet.id + '/ledger?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = await getJson(path);
      pageCount += 1;
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (pageCount < 3) expect(typeof cursor).toBe('string');
      if (pageCount === 3) expect(cursor).toBeUndefined();
      expect(pageCount).toBeLessThanOrEqual(4);
    } while (cursor);
    expect(seen).toHaveLength(expectedDebits + 1);
    expect(new Set(seen.map((entry) => entry.id)).size).toBe(seen.length);
    for (let index = 1; index < seen.length; index += 1) {
      const previous = seen[index - 1];
      const current = seen[index];
      const previousTime = Date.parse(previous.createdAt);
      const currentTime = Date.parse(current.createdAt);
      expect(previousTime >= currentTime).toBe(true);
      if (previousTime === currentTime) expect(previous.id.localeCompare(current.id)).toBeGreaterThan(0);
    }
    expect(seen.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(expectedDebits);
    expect((await getJson('/wallets/' + wallet.id + '/reconciliation', { method: 'POST' })).consistent).toBe(true);
  });

  test('two concurrent bets cannot spend the same balance twice', async () => {
    const wallet = await createWallet('100.00');
    const first = wager(wallet, { amount: '80.00', kind: 'BET', externalTransactionId: `bet-${randomUUID()}` });
    const second = wager(wallet, { amount: '80.00', kind: 'BET', externalTransactionId: `bet-${randomUUID()}` });
    const results = await Promise.all([
      postWager(first, `key:${randomUUID()}`),
      postWager(second, `key:${randomUUID()}`),
    ]);
    const bodies = await Promise.all(results.map((response) => response.json() as Promise<any>));
    expect(bodies.filter((body) => body.status === 'PROCESSED')).toHaveLength(1);
    expect(bodies.filter((body) => body.status === 'REJECTED')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('20.00');
    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a refund received before its bet is applied after the reference appears', async () => {
    const wallet = await createWallet('100.00');
    const betId = `late-bet-${randomUUID()}`;
    const sharedRoundId = `round-${randomUUID()}`;
    const refund = wager(wallet, {
      amount: '15.00', kind: 'REFUND', externalTransactionId: `refund-${randomUUID()}`,
      referenceExternalTransactionId: betId, roundId: sharedRoundId,
    });
    const refundKey = `key:${randomUUID()}`;
    const pendingResponse = await postWager(refund, refundKey);
    expect(pendingResponse.status).toBe(202);
    expect((await pendingResponse.json() as any).status).toBe('PENDING_REFERENCE');

    const bet = wager(wallet, { amount: '15.00', kind: 'BET', externalTransactionId: betId, roundId: sharedRoundId });
    const betResponse = await postWager(bet, `key:${randomUUID()}`);
    expect((await betResponse.json() as any).status).toBe('PROCESSED');

    const final = await eventually(async () => {
      const transaction = await getJson(`/providers/${refund.providerId}/wagering/transactions/${refund.externalTransactionId}`);
      return transaction.status === 'PROCESSED' ? transaction : undefined;
    }, 20_000);
    expect(final.status).toBe('PROCESSED');
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a rollback received before its WIN reference applies the inverse ledger direction', async () => {
    const wallet = await createWallet('100.00');
    const winExternalId = `late-win-${randomUUID()}`;
    const roundId = `round-${randomUUID()}`;
    const rollback = wager(wallet, {
      amount: '15.00', kind: 'ROLLBACK', externalTransactionId: `rollback-${randomUUID()}`,
      referenceExternalTransactionId: winExternalId, roundId,
    });
    const pendingResponse = await postWager(rollback, `rollback-key:${randomUUID()}`);
    expect(pendingResponse.status).toBe(202);

    const win = wager(wallet, { amount: '15.00', kind: 'WIN', externalTransactionId: winExternalId, roundId });
    expect((await postWager(win, `win-key:${randomUUID()}`)).status).toBe(200);

    const final = await eventually(async () => {
      const transaction = await getJson(`/providers/${rollback.providerId}/wagering/transactions/${rollback.externalTransactionId}`);
      return transaction.status === 'PROCESSED' ? transaction : undefined;
    }, 20_000);
    expect(final.status).toBe('PROCESSED');
    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.some((entry: any) => entry.transactionId === final.transactionId && entry.direction === 'DEBIT')).toBe(true);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('WIN, REFUND and ROLLBACK enforce reference context and exact reversal amount', async () => {
    const wallet = await createWallet('100.00');
    const roundId = `round-${randomUUID()}`;
    const bet = wager(wallet, { amount: '20.00', kind: 'BET', roundId });
    expect((await postWager(bet, `rule-bet:${randomUUID()}`)).status).toBe(200);

    const win = wager(wallet, {
      amount: '20.00', kind: 'WIN', roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await postWager(win, `rule-win:${randomUUID()}`)).status).toBe(200);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');

    const wrongAmountRefund = wager(wallet, {
      amount: '19.00', kind: 'REFUND', roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const amountFailure = await postWager(wrongAmountRefund, `rule-refund-amount:${randomUUID()}`);
    expect(amountFailure.status).toBe(422);
    expect((await amountFailure.json() as any).failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');

    const wrongRoundRollback = wager(wallet, {
      amount: '20.00', kind: 'ROLLBACK', roundId: `other-${roundId}`,
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const contextFailure = await postWager(wrongRoundRollback, `rule-rollback-round:${randomUUID()}`);
    expect(contextFailure.status).toBe(422);
    expect((await contextFailure.json() as any).failureCode).toBe('REFERENCE_CONTEXT_MISMATCH');

    const wrongPlayer = { ...wager(wallet, { amount: '1.00', kind: 'BET' }), playerId: randomUUID() };
    const playerFailure = await postWager(wrongPlayer, `rule-player:${randomUUID()}`);
    expect(playerFailure.status).toBe(422);
    expect((await playerFailure.json() as any).failureCode).toBe('WALLET_PLAYER_MISMATCH');

    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(ledger.items).toHaveLength(3); // Opening credit, BET debit, WIN credit. Rejected requests add no ledger entries.
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a ROLLBACK that would make the balance negative is rejected with its own failure code', async () => {
    const wallet = await createWallet('100.00');
    const win = wager(wallet, { amount: '80.00', kind: 'WIN' });
    expect((await postWager(win, `insufficient-rollback-win:${randomUUID()}`)).status).toBe(200);
    const bet = wager(wallet, { amount: '170.00', kind: 'BET' });
    expect((await postWager(bet, `insufficient-rollback-bet:${randomUUID()}`)).status).toBe(200);

    const rollback = wager(wallet, {
      amount: '80.00', kind: 'ROLLBACK', roundId: win.roundId,
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const response = await postWager(rollback, `insufficient-rollback:${randomUUID()}`);
    expect(response.status).toBe(422);
    expect((await response.json() as any).failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('10.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('idempotent replay returns the original response balance after later transactions', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, { amount: '10.00', kind: 'BET' });
    const key = `original-response:${randomUUID()}`;
    const first = await postWager(bet, key);
    expect(first.status).toBe(200);
    expect((await first.json() as any).balance.amount).toBe('90.00');

    const win = wager(wallet, { amount: '20.00', kind: 'WIN' });
    expect((await postWager(win, `later-win:${randomUUID()}`)).status).toBe(200);
    const replay = await postWager(bet, key);
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as any;
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance.amount).toBe('90.00');
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('110.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a processed bet can be refunded only once', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, { amount: '20.00', kind: 'BET' });
    expect((await (await postWager(bet, `key:${randomUUID()}`)).json() as any).status).toBe('PROCESSED');

    const refund = wager(wallet, {
      amount: '20.00', kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId, roundId: bet.roundId,
    });
    const firstRefund = await postWager(refund, `key:${randomUUID()}`);
    expect(firstRefund.status).toBe(200);

    const duplicateRefund = wager(wallet, {
      amount: '20.00', kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId, roundId: bet.roundId,
    });
    const secondRefund = await postWager(duplicateRefund, `key:${randomUUID()}`);
    expect(secondRefund.status).toBe(422);
    expect((await secondRefund.json() as any).failureCode).toBe('ALREADY_REVERSED');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('two SQS messages for the same wallet cannot spend the balance twice', async () => {
    const wallet = await createWallet('100.00');
    const sharedRoundId = `sqs-race-round:${randomUUID()}`;
    const first = {
      ...wager(wallet, { amount: '80.00', kind: 'BET', roundId: sharedRoundId }),
      idempotencyKey: `sqs-race-first:${randomUUID()}`,
    };
    const second = {
      ...wager(wallet, { amount: '80.00', kind: 'BET', roundId: sharedRoundId }),
      idempotencyKey: `sqs-race-second:${randomUUID()}`,
    };
    const firstMessageId = `sqs-wallet-race:${randomUUID()}`;
    const secondMessageId = `sqs-wallet-race:${randomUUID()}`;

    // Different FIFO groups deliberately let independent workers process this same wallet concurrently.
    // PostgreSQL wallet locking, not broker ordering, must protect the balance.
    await Promise.all([
      sendQueueMessage({ messageId: firstMessageId, data: first }, `${wallet.id}:worker-a`),
      sendQueueMessage({ messageId: secondMessageId, data: second }, `${wallet.id}:worker-b`),
    ]);

    const statuses = await Promise.all([first, second].map(async (request) => eventually(async () => {
      const transaction = await getJson(`/providers/${request.providerId}/wagering/transactions/${request.externalTransactionId}`);
      return ['PROCESSED', 'REJECTED'].includes(transaction.status) ? transaction.status : undefined;
    }, 25_000)));

    expect(statuses.filter((status) => status === 'PROCESSED')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'REJECTED')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('20.00');
    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('the versioned migration is applied and the real schema enforces required constraints', async () => {
    const appliedMigrations = await dbRows<{ name: string }>(
      'select name from mikro_orm_migrations where name like $1',
      ['%Migration20261022000000%'],
    );
    expect(appliedMigrations).toHaveLength(1);

    const constraintRows = await dbRows<{ conname: string }>(`
      select conname from pg_constraint
      where conrelid in ('wallets'::regclass, 'wager_transactions'::regclass, 'wallet_ledger_entries'::regclass)
    `);
    const names = constraintRows.map((row) => row.conname);
    expect(names).toContain('wallets_player_currency_uq');
    expect(names).toContain('ledger_arithmetic_ck');
    expect(names).toContain('wallet_ledger_entries_transaction_id_key');

    const wallet = await createWallet('20.00');
    await expect(dbExecute('update wallets set balance_amount = -1 where id = $1', [wallet.id])).rejects.toThrow();
    await expect(dbExecute('update wallet_ledger_entries set amount = amount where wallet_id = $1', [wallet.id])).rejects.toThrow();
    await expect(dbExecute('delete from wallet_ledger_entries where wallet_id = $1', [wallet.id])).rejects.toThrow();
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('20.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  if (localCompose) {
    test('migrations can be rolled back and reapplied against a clean PostgreSQL database', async () => {
      const migrationDbName = 'migtest_' + randomUUID().replace(/-/g, '');
      await dbExecute('create database "' + migrationDbName + '"');
      let migrationOrm: MikroORM | undefined;
      try {
        migrationOrm = await MikroORM.init({
          ...ormConfig,
          dbName: migrationDbName,
          debug: false,
          migrations: { ...ormConfig.migrations, snapshot: false },
        });
        await migrationOrm.getMigrator().up();
        const initial = await migrationOrm.em.getConnection().execute<{ wallets: string | null; ledger: string | null }[]>(
          "select to_regclass('public.wallets')::text as wallets, to_regclass('public.wallet_ledger_entries')::text as ledger",
          [], 'all',
        );
        expect(initial[0]?.wallets).toBe('wallets');
        expect(initial[0]?.ledger).toBe('wallet_ledger_entries');
        // Roll back the ledger TRUNCATE-guard migration and then the original schema migration.
        await migrationOrm.getMigrator().down();
        await migrationOrm.getMigrator().down();
        const rolledBack = await migrationOrm.em.getConnection().execute<{ wallets: string | null; ledger: string | null }[]>(
          "select to_regclass('public.wallets')::text as wallets, to_regclass('public.wallet_ledger_entries')::text as ledger",
          [], 'all',
        );
        expect(rolledBack[0]?.wallets).toBeNull();
        expect(rolledBack[0]?.ledger).toBeNull();
        await migrationOrm.getMigrator().up();
        const reapplied = await migrationOrm.em.getConnection().execute<{ wallets: string | null; ledger: string | null; immutable_trigger: boolean; truncate_trigger: boolean }[]>(
          "select to_regclass('public.wallets')::text as wallets, to_regclass('public.wallet_ledger_entries')::text as ledger, exists (select 1 from pg_trigger where tgname = 'wallet_ledger_immutable_trg' and not tgisinternal) as immutable_trigger, exists (select 1 from pg_trigger where tgname = 'wallet_ledger_no_truncate_trg' and not tgisinternal) as truncate_trigger",
          [], 'all',
        );
        expect(reapplied[0]?.wallets).toBe('wallets');
        expect(reapplied[0]?.ledger).toBe('wallet_ledger_entries');
        expect(reapplied[0]?.immutable_trigger).toBe(true);
        expect(reapplied[0]?.truncate_trigger).toBe(true);
      } finally {
        await migrationOrm?.close(true);
        await dbExecute('drop database if exists "' + migrationDbName + '" with (force)');
      }
    });
  } else {
    test.skip('migration rollback/reapply test requires the local Docker Compose PostgreSQL database user', () => {});
  }

  test('the database prevents TRUNCATE from deleting immutable ledger entries', async () => {
    if (!database) throw new Error('Integration database was not initialized.');
    const wallet = await createWallet('7.00');
    const before = await dbRows<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where wallet_id = $1',
      [wallet.id],
    );
    expect(Number(before[0]?.count)).toBe(1);

    let truncateSucceeded = false;
    try {
      await database.em.transactional(async (tx) => {
        await tx.getConnection().execute('truncate table wallet_ledger_entries', [], 'run');
        truncateSucceeded = true;
        throw new Error('ROLLBACK_TRUNCATE_PROBE');
      });
    } catch {
      // A database trigger/permission denial is expected. If TRUNCATE succeeds, the sentinel is raised after it.
    }
    expect(truncateSucceeded).toBe(false);
    const after = await dbRows<{ count: string }>(
      'select count(*)::text as count from wallet_ledger_entries where wallet_id = $1',
      [wallet.id],
    );
    expect(Number(after[0]?.count)).toBe(1);
  });

  test('a forced outbox failure rolls back wallet, ledger, inbox and transaction together and goes to DLQ', async () => {
    const wallet = await createWallet('100.00');
    const body = {
      ...wager(wallet, { amount: '10.00', kind: 'BET' }),
      providerId: 'atomicity-test-provider',
      idempotencyKey: `atomicity:${randomUUID()}`,
    };
    const messageId = `atomicity:${randomUUID()}`;

    await dbExecute('drop trigger if exists test_fail_atomicity_outbox_trg on outbox_messages');
    await dbExecute('drop function if exists test_fail_atomicity_outbox()');
    await dbExecute(`
      create function test_fail_atomicity_outbox() returns trigger as $$
      begin
        if NEW.payload->'data'->>'providerId' = 'atomicity-test-provider' then
          raise exception 'forced atomicity-test outbox failure' using errcode = 'P0001';
        end if;
        return NEW;
      end;
      $$ language plpgsql
    `);
    await dbExecute(`
      create trigger test_fail_atomicity_outbox_trg
      before insert on outbox_messages for each row execute function test_fail_atomicity_outbox()
    `);

    try {
      await sendQueueMessage({ messageId, data: body }, wallet.id);
      await waitForDlqMessage(messageId, 20_000);

      const transactions = await dbRows<{ count: string }>(
        'select count(*)::text as count from wager_transactions where provider_id = $1 and external_transaction_id = $2',
        [body.providerId, body.externalTransactionId],
      );
      const inbox = await dbRows<{ count: string }>(
        'select count(*)::text as count from inbox_messages where consumer_name = $1 and message_id = $2',
        ['wager-transactions-consumer', messageId],
      );
      const debitEntries = await dbRows<{ count: string }>(
        "select count(*)::text as count from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'",
        [wallet.id],
      );
      expect(Number(transactions[0]?.count)).toBe(0);
      expect(Number(inbox[0]?.count)).toBe(0);
      expect(Number(debitEntries[0]?.count)).toBe(0);
      expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
      expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    } finally {
      await dbExecute('drop trigger if exists test_fail_atomicity_outbox_trg on outbox_messages');
      await dbExecute('drop function if exists test_fail_atomicity_outbox()');
    }
  });

  if (baseUrls.length >= 3) {
    test('three independent API instances are live at the same time', async () => {
      const checks = await Promise.all(baseUrls.slice(0, 3).map((url) => fetch(`${url}/health/live`)));
      expect(checks.map((response) => response.status)).toEqual([200, 200, 200]);
    });

    test('three publisher processes deliver all concurrent outbox events without missing transaction events', async () => {
    const wallet = await createWallet('0.00');
    const requests = Array.from({ length: 40 }, () => {
      const body = wager(wallet, { amount: '1.00', kind: 'LOSS' });
      return { body, key: `publishers:${randomUUID()}` };
    });
    const responses = await Promise.all(requests.map(({ body, key }) => postWager(body, key)));
    const failedResponses = await Promise.all(
      responses.map(async (response, index) => response.status === 200 ? null : ({
        index,
        status: response.status,
        body: await response.clone().text(),
      })),
    );
    expect(failedResponses.filter(Boolean)).toEqual([]);
    const results = await Promise.all(responses.map((response) => response.json() as Promise<any>));
    const transactionIds = new Set<string>(results.map((result) => result.transactionId));
    expect(transactionIds.size).toBe(40);

    const eventIds = await collectProcessedEvents(transactionIds, 30_000);
    expect(eventIds.size).toBe(40);

    const transactionIdsList = [...transactionIds];
    const placeholders = transactionIdsList
      .map((_, index) => `$${index + 1}`)
      .join(', ');

    const outboxRows = await dbRows<{ total: string; pending: string }>(`
      select count(*)::text as total,
        count(*) filter (where published_at is null)::text as pending
      from outbox_messages
      where payload->'data'->>'transactionId' in (${placeholders})
        and event_type = 'WagerTransactionProcessed'
    `, transactionIdsList);
    expect(Number(outboxRows[0]?.total)).toBe(40);
    expect(Number(outboxRows[0]?.pending)).toBe(0);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    });
  } else {
    test.skip('three-instance and concurrent-publisher checks require at least three API_BASE_URLS', () => {});
  }

  test('the database rejects a currency code outside the supported ISO 4217 allow-list', async () => {
    const wallet = await createWallet('5.00');
    await expect(dbExecute('update wallets set currency = $1 where id = $2', ['ZZZ', wallet.id])).rejects.toThrow();
    await expect(dbExecute('update wallets set currency = $1 where id = $2', ['ANG', wallet.id])).rejects.toThrow();
    await expect(dbExecute('update wallets set currency = $1 where id = $2', ['XTS', wallet.id])).rejects.toThrow();
    await expect(dbExecute('update wallets set currency = $1 where id = $2', ['XXX', wallet.id])).rejects.toThrow();
    const xad = await dbRows<{ accepted: boolean }>('select is_iso4217_currency($1) as accepted', ['XAD']);
    expect(xad[0]?.accepted).toBe(true);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.currency).toBe('BRL');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('a credit that would overflow the wallet balance is rejected and remains auditable', async () => {
    const wallet = await createWallet('999999999999999999.99');
    const win = wager(wallet, { amount: '0.01', kind: 'WIN' });
    const response = await postWager(win, `balance-overflow:${randomUUID()}`);

    expect(response.status).toBe(422);
    expect((await response.json() as any).failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('999999999999999999.99');
    const stored = await getJson(`/providers/${win.providerId}/wagering/transactions/${win.externalTransactionId}`);
    expect(stored.status).toBe('REJECTED');
    expect(stored.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.transactionId === stored.transactionId)).toHaveLength(0);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('reconciliation remains correct when lifetime ledger totals exceed numeric(20,2)', async () => {
    const wallet = await createWallet('0.00');
    const maximum = '999999999999999999.99';

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const win = wager(wallet, { amount: maximum, kind: 'WIN' });
      const bet = wager(wallet, { amount: maximum, kind: 'BET' });
      expect((await postWager(win, `large-credit:${randomUUID()}`)).status).toBe(200);
      expect((await postWager(bet, `large-debit:${randomUUID()}`)).status).toBe(200);
    }

    const reconciliation = await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('0.00');
    expect(reconciliation.calculatedBalance.amount).toBe('0.00');
    expect(reconciliation.difference.amount).toBe('0.00');
    expect(reconciliation.checkedEntries).toBe(4);
  });

  test('reconciliation reports, logs and counts a stored-balance mismatch', async () => {
    const wallet = await createWallet('30.00');
    const mismatchesBefore = await metricTotal('wager_reconciliation_mismatches_total');
    await dbExecute('update wallets set balance_amount = $1 where id = $2', ['31.00', wallet.id]);
    const result = await getJson('/wallets/' + wallet.id + '/reconciliation', { method: 'POST' });
    expect(result.consistent).toBe(false);
    expect(result.storedBalance).toEqual({ amount: '31.00', currency: 'BRL' });
    expect(result.calculatedBalance).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(result.checkedEntries).toBe(1);
    await eventually(async () => {
      const total = await metricTotal('wager_reconciliation_mismatches_total');
      return total === mismatchesBefore + 1 ? true : undefined;
    }, 10_000);
    if (localCompose) {
      const log = await eventually(async () => {
        const output = runCompose('logs', '--no-color', '--since', '2m', 'api', 'api-2', 'api-3');
        return output.split('\n').find((line) => line.includes('"message":"wallet_reconciliation_mismatch"')
          && line.includes('"walletId":"' + wallet.id + '"'));
      }, 10_000);
      expect(log).toContain('"level":"warn"');
      expect(log).not.toContain('"storedBalance"');
      expect(log).not.toContain('"calculatedBalance"');
    }
  });

  test('HTTP rejects an amount without exactly two decimal places before persistence', async () => {
    const wallet = await createWallet('100.00');
    const body = {
      ...wager(wallet, { amount: '10.00', kind: 'BET' }),
      money: { amount: '10.001', currency: 'BRL' },
    };
    const response = await postWager(body, `scale:${randomUUID()}`);
    expect(response.status).toBe(400);

    const rows = await dbRows<{ count: string }>(
      'select count(*)::text as count from wager_transactions where external_transaction_id = $1',
      [body.externalTransactionId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('SQS business rejection is persisted, emitted, and acknowledged rather than sent to DLQ', async () => {
    const wallet = await createWallet('5.00');
    const request = {
      ...wager(wallet, { amount: '10.00', kind: 'BET' }),
      idempotencyKey: `business-rejection:${randomUUID()}`,
    };
    const messageId = `business-rejection:${randomUUID()}`;
    await sendQueueMessage({ messageId, data: request }, wallet.id);

    const rejected = await eventually(async () => {
      const value = await getJson(`/providers/${request.providerId}/wagering/transactions/${request.externalTransactionId}`);
      return value.status === 'REJECTED' ? value : undefined;
    }, 20_000);
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('5.00');

    const inbox = await eventually(async () => {
      const rows = await dbRows<{ processed_at: Date | string | null }>(
        'select processed_at from inbox_messages where consumer_name = $1 and message_id = $2',
        ['wager-transactions-consumer', messageId],
      );
      return rows[0]?.processed_at ? rows[0] : undefined;
    }, 10_000);
    expect(inbox.processed_at).toBeTruthy();

    const rejectedEvent = await eventually(async () => {
      const rows = await dbRows<{ published_at: Date | string | null }>(
        `select published_at from outbox_messages
         where event_type = 'WagerTransactionRejected'
           and payload->'data'->>'transactionId' = $1`,
        [rejected.transactionId],
      );
      return rows[0]?.published_at ? rows[0] : undefined;
    }, 15_000);
    expect(rejectedEvent.published_at).toBeTruthy();

    const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(0);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  test('an invalid SQS money payload is moved to DLQ without creating a financial transaction', async () => {
    const wallet = await createWallet('100.00');
    const body = {
      ...wager(wallet, { amount: '10.00', kind: 'BET' }),
      money: { amount: '10.001', currency: 'BRL' },
      idempotencyKey: `invalid:${randomUUID()}`,
    };
    const messageId = `invalid-money:${randomUUID()}`;
    await sendQueueMessage({ messageId, data: body }, wallet.id);
    const deadLetter = await waitForDlqMessage(messageId, 20_000);
    expect(String(deadLetter.reason)).toContain('INVALID_MESSAGE');

    const transactions = await dbRows<{ count: string }>(
      'select count(*)::text as count from wager_transactions where provider_id = $1 and external_transaction_id = $2',
      [body.providerId, body.externalTransactionId],
    );
    expect(Number(transactions[0]?.count)).toBe(0);
    expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
  });

  if (localCompose && process.env.ENABLE_TEST_FAULT_INJECTION === '1') {
    test('a transient SQS processing failure retries and eventually applies exactly once', async () => {
      const wallet = await createWallet('100.00');
      const body = {
        ...wager(wallet, { amount: '12.00', kind: 'BET' }),
        idempotencyKey: `retry:${randomUUID()}`,
      };
      const messageId = `test-transient-retry:${randomUUID()}`;
      const retriesBefore = await totalSqsRetries();
      await sendQueueMessage({ messageId, data: body }, wallet.id);

      const processed = await eventually(async () => {
        const transaction = await getJson(`/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
        return transaction.status === 'PROCESSED' ? transaction : undefined;
      }, 30_000);
      expect(processed.status).toBe('PROCESSED');
      await eventually(async () => (await totalSqsRetries()) >= retriesBefore + 2 ? true : undefined, 10_000);
      expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('88.00');
      const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
      expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
      expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    });

    test('persistent transient failures are retried and then sent to DLQ without applying money', async () => {
      const wallet = await createWallet('100.00');
      const body = {
        ...wager(wallet, { amount: '12.00', kind: 'BET' }),
        idempotencyKey: `exhaust:${randomUUID()}`,
      };
      const messageId = `test-transient-exhaust:${randomUUID()}`;
      const retriesBefore = await totalSqsRetries();
      await sendQueueMessage({ messageId, data: body }, wallet.id);
      const deadLetter = await waitForDlqMessage(messageId, 70_000);
      expect(deadLetter.reason).toBe('TRANSIENT_RETRY_LIMIT_EXCEEDED');
      await eventually(async () => (await totalSqsRetries()) >= retriesBefore + 3 ? true : undefined, 10_000);

      const transactions = await dbRows<{ count: string }>(
        'select count(*)::text as count from wager_transactions where provider_id = $1 and external_transaction_id = $2',
        [body.providerId, body.externalTransactionId],
      );
      const inbox = await dbRows<{ count: string }>(
        'select count(*)::text as count from inbox_messages where consumer_name = $1 and message_id = $2',
        ['wager-transactions-consumer', messageId],
      );
      expect(Number(transactions[0]?.count)).toBe(0);
      expect(Number(inbox[0]?.count)).toBe(0);
      expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('100.00');
      expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    });

    test('worker crash after commit and before ACK is recovered by inbox deduplication', async () => {
      const wallet = await createWallet('100.00');
      const body = {
        ...wager(wallet, { amount: '10.00', kind: 'BET' }),
        idempotencyKey: `crash:${randomUUID()}`,
      };
      const messageId = `test-crash-before-ack:${randomUUID()}`;
      const restartsBefore = composeRestartCounts();
      await sendQueueMessage({ messageId, data: body }, wallet.id);

      const processed = await eventually(async () => {
        const transaction = await getJson(`/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);
        return transaction.status === 'PROCESSED' ? transaction : undefined;
      }, 20_000);
      expect(processed.status).toBe('PROCESSED');
      await eventually(async () => {
        const after = composeRestartCounts();
        return Object.keys(restartsBefore).some((service) => after[service] > restartsBefore[service]) ? true : undefined;
      }, 20_000);

      // The restarted worker receives the unacknowledged message again; inbox prevents a second debit.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect((await getJson(`/wallets/${wallet.id}`)).balance.amount).toBe('90.00');
      const ledger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
      expect(ledger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
      const inbox = await dbRows<{ count: string }>(
        'select count(*)::text as count from inbox_messages where consumer_name = $1 and message_id = $2',
        ['wager-transactions-consumer', messageId],
      );
      expect(Number(inbox[0]?.count)).toBe(1);
      expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
    });
  } else {
    test.skip('transient retry and crash-before-ACK fault-injection scenarios require ENABLE_TEST_FAULT_INJECTION=1 in the API containers', () => {});
  }

  if (localCompose) {
    test('an outbox event committed before service restart is published after LocalStack and APIs restart', async () => {
      const wallet = await createWallet('0.00');
      const body = wager(wallet, { amount: '1.00', kind: 'LOSS' });
      let result: any;

      runCompose('stop', 'localstack');
      try {
        const response = await postWager(body, `restart:${randomUUID()}`);
        expect(response.status).toBe(200);
        result = await response.json();

        // Stop publishers while the durable outbox row is still pending, then restore dependencies.
        runCompose('stop', 'api', 'api-2', 'api-3');
        runCompose('up', '-d', 'localstack');
        await waitForLocalStack();
        runCompose('up', '-d', 'api', 'api-2', 'api-3');
        await waitForApis();

        const eventIds = await collectProcessedEvents(new Set([result.transactionId]), 30_000);
        expect(eventIds.size).toBe(1);
        const published = await eventually(async () => {
          const rows = await dbRows<{ published_at: Date | string | null }>(
            `select published_at from outbox_messages
             where event_type = 'WagerTransactionProcessed'
               and payload->'data'->>'transactionId' = $1`,
            [result.transactionId],
          );
          return rows[0]?.published_at ? rows : undefined;
        }, 10_000);
        expect(published[0]?.published_at).toBeTruthy();
        expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);
      } finally {
        // Keep the local development stack usable even if an assertion fails.
        runCompose('up', '-d', 'localstack', 'api', 'api-2', 'api-3');
        await waitForApis().catch(() => undefined);
      }
    });
  } else {
    test.skip('service-restart recovery test requires the local Docker Compose stack', () => {});
  }

  test('metrics endpoint exposes every required challenge metric family', async () => {
    const requiredMetrics = [
      'wager_transactions_total',
      'wager_idempotent_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages',
      'wager_lock_conflicts_total',
      'wager_outbox_lag_seconds',
      'wager_processing_latency_seconds',
    ];
    for (const url of baseUrls) {
      const response = await fetch(url + '/metrics');
      expect(response.ok).toBe(true);
      const exposition = await response.text();
      for (const name of requiredMetrics) {
        expect(exposition).toMatch(new RegExp('^# TYPE ' + name + ' (?:counter|gauge|histogram)$', 'm'));
      }
    }
  });

  if (localCompose) {
    test('outbox publisher logs preserve the WalletBalanceChanged transaction and correlation context', async () => {
      const wallet = await createWallet('10.00');
      const opening = await eventually(async () => {
        const rows = await dbRows<{ id: string }>(
          "select id from wager_transactions where wallet_id = $1 and kind = 'OPENING'",
          [wallet.id],
        );
        return rows[0];
      }, 5_000);
      const log = await eventually(async () => {
        const output = runCompose('logs', '--no-color', '--since', '2m', 'api', 'api-2', 'api-3');
        const line = output.split('\n').find((entry) => entry.includes('"message":"outbox_event_published"')
          && entry.includes('"eventType":"WalletBalanceChanged"')
          && entry.includes('"' + wallet.id + '"'));
        if (!line) return undefined;
        const start = line.indexOf('{');
        if (start < 0) return undefined;
        try { return JSON.parse(line.slice(start)); } catch { return undefined; }
      }, 10_000);
      expect(log.transactionId).toBe(opening.id);
      expect(log.walletId).toBe(wallet.id);
      expect(log.correlationId).toBe(opening.id);
      expect(log.providerId).toBe('internal');
    });
  } else {
    test.skip('outbox logging context test requires the local Docker Compose stack', () => {});
  }

  test('SQS ingress commits the persistent inbox and publishes transactional outbox events', async () => {
    const wallet = await createWallet('200.00');
    const request = wager(wallet, { amount: '25.00', kind: 'BET' });
    const envelope = {
      messageId: `msg-${randomUUID()}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...request, idempotencyKey: `key:${randomUUID()}` },
    };
    const idempotencyKey = envelope.data.idempotencyKey;

    await sqs.send(new SendMessageCommand({
      QueueUrl: transactionsQueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));
    const processed = await eventually(async () => {
      const tx = await getJson(`/providers/${request.providerId}/wagering/transactions/${request.externalTransactionId}`);
      return tx.status === 'PROCESSED' ? tx : undefined;
    }, 20_000);
    expect(processed.status).toBe('PROCESSED');

    // Send the same application message id again with a different transport deduplication id.
    await sqs.send(new SendMessageCommand({
      QueueUrl: transactionsQueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: randomUUID(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sqsLedger = await getJson(`/wallets/${wallet.id}/ledger?limit=100`);
    expect(sqsLedger.items.filter((entry: any) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect((await getJson(`/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).consistent).toBe(true);

    const events = await eventually(async () => {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 3,
      }));
      const matches = [] as any[];
      for (const message of received.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;
        try {
          const event = JSON.parse(message.Body);
          if (event.data?.transactionId === processed.transactionId) matches.push(event);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: message.ReceiptHandle }));
        } catch {
          // Ignore malformed messages in the test queue; production data is checked by consumers.
        }
      }
      return matches.length > 0 ? matches : undefined;
    }, 15_000);
    expect(events.some((event) => event.eventType === 'WagerTransactionProcessed')).toBe(true);
    expect(typeof idempotencyKey).toBe('string');
  });
}

async function dbRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!database) throw new Error('Integration database was not initialized.');
  const bound = normalizeSql(sql, params);
  return await database.em.getConnection().execute<T[]>(bound.query, bound.params as any[], 'all') as T[];
}

async function dbExecute(sql: string, params: unknown[] = []): Promise<void> {
  if (!database) throw new Error('Integration database was not initialized.');
  const bound = normalizeSql(sql, params);
  await database.em.getConnection().execute(bound.query, bound.params as any[], 'run');
}

async function sendQueueMessage(
  envelope: { messageId: string; data: Record<string, unknown> },
  groupId: string,
): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: transactionsQueueUrl,
    MessageBody: JSON.stringify({
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      ...envelope,
    }),
    MessageGroupId: groupId,
    MessageDeduplicationId: randomUUID(),
  }));
}

async function waitForDlqMessage(originalMessageId: string, timeoutMs: number): Promise<any> {
  return eventually(async () => {
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 3,
    }));
    for (const message of received.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      let deadLetter: any;
      try { deadLetter = JSON.parse(message.Body); } catch { deadLetter = undefined; }
      let source: any;
      try { source = typeof deadLetter?.originalBody === 'string' ? JSON.parse(deadLetter.originalBody) : undefined; } catch { source = undefined; }
      if (source?.messageId === originalMessageId) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: deadLetterQueueUrl, ReceiptHandle: message.ReceiptHandle }));
        return deadLetter;
      }
      // Leave unrelated DLQ messages available to their owning test.
      await sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: deadLetterQueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 5,
      }));
    }
    return undefined;
  }, timeoutMs);
}

async function collectProcessedEvents(transactionIds: Set<string>, timeoutMs: number): Promise<Set<string>> {
  const found = new Set<string>();
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt && found.size < transactionIds.size) {
    const received = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: eventsQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 3,
    }));
    for (const message of received.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      try {
        const event = JSON.parse(message.Body);
        if (event.eventType === 'WagerTransactionProcessed'
          && transactionIds.has(String(event.data?.transactionId))) {
          found.add(String(event.data.transactionId));
        }
      } finally {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
    }
  }
  if (found.size !== transactionIds.size) {
    throw new Error(`Received ${found.size}/${transactionIds.size} expected processed events before timeout.`);
  }
  return found;
}


async function metricTotal(metricName: string): Promise<number> {
  const values = await Promise.all(baseUrls.map(async (url) => {
    const response = await fetch(url + '/metrics');
    if (!response.ok) throw new Error('Metrics endpoint returned ' + response.status);
    const exposition = await response.text();
    const match = exposition.match(new RegExp('^' + metricName + '\\s+([0-9.eE+-]+)$', 'm'));
    return match ? Number(match[1]) : 0;
  }));
  return values.reduce((sum, value) => sum + value, 0);
}

async function totalSqsRetries(): Promise<number> {
  const values = await Promise.all(baseUrls.map(async (url) => {
    const response = await fetch(`${url}/metrics`);
    if (!response.ok) return 0;
    const text = await response.text();
    const match = text.match(/^wager_retries_total\{source="sqs"\}\s+([0-9.]+)/m);
    return match ? Number(match[1]) : 0;
  }));
  return values.reduce((sum, value) => sum + value, 0);
}

function runCompose(...args: string[]): string {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return result.stdout;
}

function composeRestartCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const service of ['api', 'api-2', 'api-3']) {
    const containerId = runCompose('ps', '-q', service).trim();
    if (!containerId) throw new Error(`No container found for Compose service ${service}.`);
    const output = execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', containerId], { encoding: 'utf8' });
    counts[service] = Number(output.trim());
  }
  return counts;
}

async function waitForLocalStack(): Promise<void> {
  await eventually(async () => {
    const response = await fetch(`${endpoint}/_localstack/health`).catch(() => undefined);
    if (!response?.ok) return undefined;
    const data = await response.json() as { services?: Record<string, string> };
    return data.services?.sqs === 'running' ? true : undefined;
  }, 60_000);
}

async function waitForApis(): Promise<void> {
  await eventually(async () => {
    const responses = await Promise.all(baseUrls.slice(0, 3).map((url) => fetch(`${url}/health/ready`).catch(() => undefined)));
    return responses.length >= 3 && responses.every((response) => response?.ok) ? true : undefined;
  }, 60_000);
}

async function createWallet(initialAmount: string): Promise<{ id: string; playerId: string }> {
  const playerId = randomUUID();
  const response = await fetch(`${nextBaseUrl()}/wallets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
  });
  if (!response.ok) throw new Error(`Wallet setup failed: ${response.status} ${await response.text()}`);
  const wallet = await response.json() as { id: string; playerId: string };
  return { id: wallet.id, playerId };
}

function wager(
  wallet: { id: string; playerId: string },
  options: { amount: string; kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK'; externalTransactionId?: string; referenceExternalTransactionId?: string; roundId?: string },
) {
  return {
    providerId: 'integration-provider',
    externalTransactionId: options.externalTransactionId ?? `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: options.roundId ?? `round-${randomUUID()}`,
    gameId: 'integration-game',
    kind: options.kind,
    money: { amount: options.amount, currency: 'BRL' },
    ...(options.referenceExternalTransactionId ? { referenceExternalTransactionId: options.referenceExternalTransactionId } : {}),
  };
}

async function postWager(body: ReturnType<typeof wager>, idempotencyKey: string): Promise<Response> {
  return fetch(`${nextBaseUrl()}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

async function getJson(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${nextBaseUrl()}${path}`, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}: ${await response.text()}`);
  return response.json();
}

function nextBaseUrl(): string {
  const selected = baseUrls[nextBaseUrlIndex % baseUrls.length];
  nextBaseUrlIndex += 1;
  if (!selected) throw new Error('Configure API_BASE_URL or API_BASE_URLS with at least one URL.');
  return selected;
}

async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const stopAt = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < stopAt) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}
