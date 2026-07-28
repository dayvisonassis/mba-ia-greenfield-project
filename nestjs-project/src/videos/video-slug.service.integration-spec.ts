import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoSlugService } from './video-slug.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoSlugService (integration)', () => {
  let dataSource: DataSource;
  let service: VideoSlugService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    service = new VideoSlugService(dataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `slug_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `slug_channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function insertVideo(channelId: string, slug: string): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        slug,
        title: 'Test video',
        original_filename: 'clip.mp4',
        declared_mime: 'video/mp4',
        declared_size_bytes: 2048,
      }),
    );
  }

  it('should generate a slug that the unique index actually accepts', async () => {
    const channel = await createChannel();

    const slug = await service.generateUniqueSlug();
    const saved = await insertVideo(channel.id, slug);

    expect(saved.slug).toBe(slug);
  });

  it('should never return a slug already stored in the database', async () => {
    const channel = await createChannel();

    // Seed rows, then assert fresh generations avoid all of them.
    const taken = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const slug = await service.generateUniqueSlug();
      await insertVideo(channel.id, slug);
      taken.add(slug);
    }

    for (let i = 0; i < 20; i++) {
      const slug = await service.generateUniqueSlug();
      expect(taken.has(slug)).toBe(false);
    }
  });

  it('should see uncommitted rows when given the caller transaction manager', async () => {
    const channel = await createChannel();

    await dataSource.transaction(async (manager) => {
      const slug = await service.generateUniqueSlug(manager);
      await manager.save(
        manager.create(Video, {
          channel_id: channel.id,
          slug,
          title: 'Test video',
          original_filename: 'clip.mp4',
          declared_mime: 'video/mp4',
          declared_size_bytes: 2048,
        }),
      );

      // The row is not committed yet. Generating again on the same manager
      // must not hand back the slug that row already holds.
      const next = await service.generateUniqueSlug(manager);
      expect(next).not.toBe(slug);
    });
  });
});
