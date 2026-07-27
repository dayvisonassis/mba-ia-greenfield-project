import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1785186637009 } from './migrations/1785186637009-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_processing_status_enum',
  'videos_visibility_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1785186637009,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, NOT Promise.all. These DROPs take overlapping locks — a
    // `DROP TABLE videos CASCADE` needs a lock on `channels` for the FK, and
    // vice versa — so running them concurrently deadlocks Postgres. The
    // parallel form survived while the FK graph was shallow; adding `videos`
    // made the cycle reachable.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // A Postgres enum type is an independent object: DROP TABLE ... CASCADE
    // does not remove it. Left behind, it makes the next run's CREATE TYPE
    // fail with "already exists" — so this suite must drop it explicitly.
    for (const enumType of MANAGED_ENUM_TYPES) {
      await dataSource.query(
        `DROP TYPE IF EXISTS "public"."${enumType}" CASCADE`,
      );
    }
  });

  afterAll(async () => {
    try {
      // The second test undoes the last migration, leaving the videos table
      // missing. Re-apply so the shared DB is fully migrated for later suites.
      await dataSource.runMigrations();
    } finally {
      // destroy() must run even if re-applying fails, otherwise the open pg
      // connection keeps the event loop alive and Jest never exits.
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table with both enum types', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(tables).toHaveLength(0);

    // The enum types must go down with the table. A leftover type makes the
    // next CREATE TYPE fail with "already exists" — the exact failure mode
    // MANAGED_ENUM_TYPES exists to guard against.
    const enums = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type
       WHERE typtype = 'e' AND typname = ANY($1::text[])`,
      [['videos_processing_status_enum', 'videos_visibility_enum']],
    );
    expect(enums).toHaveLength(0);
  });
});
