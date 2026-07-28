import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the display title to `videos`.
 *
 * The CLI generated a bare `ADD "title" ... NOT NULL`, which fails on any table
 * that already holds rows. The three steps below are the data-migration form
 * the project's migration rules allow: add nullable, backfill, then constrain.
 *
 * Existing rows are backfilled from `original_filename` minus its extension —
 * the same rule the service applies when a client sends no title, so rows
 * created before and after this migration are indistinguishable.
 */
export class AddVideoTitle1785209037081 implements MigrationInterface {
  name = 'AddVideoTitle1785209037081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `IF NOT EXISTS` per the project's migration rules. It matters here in
    // particular: the test data sources default to `synchronize: true`, so a
    // suite can materialise this column from the entity without the migration
    // bookkeeping ever recording it.
    await queryRunner.query(
      `ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "title" character varying(255)`,
    );
    await queryRunner.query(
      `UPDATE "videos" SET "title" = NULLIF(regexp_replace("original_filename", '\\.[^.]*$', ''), '') WHERE "title" IS NULL`,
    );
    // A filename that was nothing but an extension leaves the expression empty.
    await queryRunner.query(
      `UPDATE "videos" SET "title" = 'video' WHERE "title" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "title" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN IF EXISTS "title"`,
    );
  }
}
