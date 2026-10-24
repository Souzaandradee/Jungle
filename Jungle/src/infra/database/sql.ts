import type { EntityManager } from '@mikro-orm/core';

export function normalizeSql(sql: string, params: unknown[] = []) {
  const boundParams: unknown[] = [];

  const query = sql.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex) - 1;

    if (index < 0 || index >= params.length) {
      throw new Error(`SQL placeholder $${rawIndex} has no matching parameter`);
    }

    boundParams.push(params[index]);
    return '?';
  });

  return { query, params: boundParams };
}

export async function rows<T>(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const bound = normalizeSql(sql, params);

  return await em.getConnection().execute<T[]>(
    bound.query,
    bound.params as any[],
    'all',
    em.getTransactionContext(),
  );
}

export async function execute(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const bound = normalizeSql(sql, params);

  await em.getConnection().execute(
    bound.query,
    bound.params as any[],
    'run',
    em.getTransactionContext(),
  );
}
