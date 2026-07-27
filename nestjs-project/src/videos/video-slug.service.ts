import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Video } from './entities/video.entity';

/**
 * Base62. Every character is URL-safe with no escaping, so the slug can be
 * dropped straight into a path segment. Deliberately excludes `-` and `_`,
 * which are legal but read badly at word boundaries in a short identifier.
 */
const SLUG_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 11 characters of base62 is ~65 bits of entropy (62^11 ≈ 5.2e19) and fits the
 * `varchar(16)` column with room to spare. At this size a collision is
 * vanishingly unlikely — the retry loop below exists for correctness under the
 * unique index, not because collisions are expected.
 */
const SLUG_LENGTH = 11;

const MAX_ATTEMPTS = 5;

/** `randomInt` rejects biased samples; `randomBytes(1) % 62` would not. */
function generateSlug(): string {
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  }
  return slug;
}

@Injectable()
export class VideoSlugService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Returns a slug that no row currently holds.
   *
   * This is the pre-check half of the collision handling, mirroring
   * `ChannelsService.createChannel`. The caller inserts the row and owns the
   * insert-time race: another request can claim the same slug between this
   * check and the INSERT, and the unique index is what catches that.
   *
   * Pass the caller's `EntityManager` when generating inside a transaction, so
   * the check sees that transaction's uncommitted rows.
   */
  async generateUniqueSlug(manager?: EntityManager): Promise<string> {
    const runner = manager ?? this.dataSource.manager;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const slug = generateSlug();
      const existing = await runner.findOne(Video, { where: { slug } });
      if (!existing) {
        return slug;
      }
    }

    // Failing loudly beats returning a slug we know is taken: the caller would
    // hit the unique index anyway, but with no clue why.
    throw new Error(
      `Could not generate a free video slug after ${MAX_ATTEMPTS} attempts`,
    );
  }
}
