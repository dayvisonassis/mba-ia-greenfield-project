import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video, VideoProcessingStatus, VideoVisibility } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
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
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, slug: string): Partial<Video> {
    return {
      channel_id: channelId,
      slug,
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: 1_048_576,
    };
  }

  it('should default processing_status to uploading and visibility to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, 'abc123')),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(found.visibility).toBe(VideoVisibility.DRAFT);
  });

  it('should leave every worker-written metadata field null on creation', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, 'meta01')),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    // These are written only by the worker after ffprobe runs.
    expect(found.duration_seconds).toBeNull();
    expect(found.width).toBeNull();
    expect(found.height).toBeNull();
    expect(found.video_codec).toBeNull();
    expect(found.audio_codec).toBeNull();
    expect(found.format_name).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.bitrate).toBeNull();
    expect(found.failure_reason).toBeNull();
    expect(found.upload_id).toBeNull();
  });

  it('should enforce the unique slug constraint', async () => {
    const channel = await createChannel();
    const other = await createChannel();

    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, 'dupslug')),
    );

    // Slug uniqueness is global, not per-channel: it is the public URL.
    await expect(
      videoRepository.save(
        videoRepository.create(buildVideo(other.id, 'dupslug')),
      ),
    ).rejects.toThrow();
  });

  it('should delete the channel videos when the channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, 'casc01')),
    );

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should read declared_size_bytes back as a number, not a bigint string', async () => {
    const channel = await createChannel();
    const declared = 10_737_418_240; // 10 GiB — the phase ceiling

    const saved = await videoRepository.save(
      videoRepository.create({
        ...buildVideo(channel.id, 'bigint1'),
        declared_size_bytes: declared,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    // Postgres bigint arrives as a string from the driver; the transformer
    // converts it back. Without it every consumer would compare a string.
    expect(typeof found.declared_size_bytes).toBe('number');
    expect(found.declared_size_bytes).toBe(declared);
  });
});
