import 'dotenv/config';
import { DataSource } from 'typeorm';
import { CreateUsersAndChannels1775687773260 } from '../src/database/migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from '../src/database/migrations/1777579850478-CreateAuthTokens';

// Migrations are imported as classes, not globs: TypeORM glob patterns do not
// resolve reliably inside the Jest sandbox (see .claude/rules/typeorm-migrations.md).
const MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
];

/**
 * Jest globalSetup — prepares the test database before any suite runs.
 *
 * Runs here rather than in an npm script so that running a single file
 * (`npx jest path/to/file`) is just as safe as running the whole suite.
 *
 * E2E tests boot AppModule with `synchronize: false`, so the schema has to be
 * migrated up front; integration tests build their own DataSource but share
 * this database.
 */
export default async function globalSetup(): Promise<void> {
  const host = process.env.DB_HOST ?? 'db';
  const port = Number(process.env.DB_PORT ?? 5432);
  const user = process.env.DB_USERNAME ?? 'streamtube';
  const password = process.env.DB_PASSWORD ?? 'streamtube';
  const database = process.env.DB_NAME ?? 'streamtube_test';

  // Postgres has no CREATE DATABASE IF NOT EXISTS — check the catalog first.
  // Connect to the default `postgres` database because the target may not exist.
  // Uses a TypeORM DataSource rather than `pg` directly: `pg` ships no types and
  // the project does not depend on @types/pg, which would break `npm run lint`.
  const admin = new DataSource({
    type: 'postgres',
    host,
    port,
    username: user,
    password,
    database: 'postgres',
  });
  await admin.initialize();
  try {
    const existing = await admin.query<unknown[]>(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (existing.length === 0) {
      await admin.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await admin.destroy();
  }

  const dataSource = new DataSource({
    type: 'postgres',
    host,
    port,
    username: user,
    password,
    database,
    migrations: MIGRATIONS,
  });

  await dataSource.initialize();
  try {
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
