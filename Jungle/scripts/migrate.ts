import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
const ormConfig = require('../dist/infra/database/mikro-orm.config').default;

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  try {
    await orm.getMigrator().up();
    console.log(JSON.stringify({ level: 'info', message: 'migrations_applied' }));
  } finally {
    await orm.close(true);
  }
}

void main();
