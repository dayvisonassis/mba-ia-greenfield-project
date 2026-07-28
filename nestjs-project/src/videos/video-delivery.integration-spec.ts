import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * End-to-end delivery against real MinIO: the presigned URL must serve the
 * object, honour `Range` with a `206`, and carry the download disposition —
 * all without the API touching a single byte (per phase-03-videos/TD-07).
 */
describe('video delivery (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let config: ConfigType<typeof storageConfig>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  const PAYLOAD = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    config = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `deliv_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `deliv_ch_${counter}`,
        user_id: user.id,
      }),
    );
  }

  /** A ready video whose object really sits in the bucket. */
  async function seedReadyVideo(
    channelId: string,
    originalFilename = 'my holiday.mp4',
  ): Promise<Video> {
    counter += 1;
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        slug: `deliv${counter}`,
        original_filename: originalFilename,
        declared_mime: 'video/mp4',
        declared_size_bytes: PAYLOAD.length,
        processing_status: 'ready' as Video['processing_status'],
      }),
    );

    await storage.putObject(
      config.videosBucket,
      `${video.id}/source`,
      PAYLOAD,
      'video/mp4',
    );

    return video;
  }

  it('should serve the whole object through the signed stream url', async () => {
    const channel = await createChannel();
    const video = await seedReadyVideo(channel.id);

    const url = await service.buildStreamUrl(channel.id, video.slug);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  it('should honour Range with a 206 served by the storage, not by the API', async () => {
    const channel = await createChannel();
    const video = await seedReadyVideo(channel.id);

    const url = await service.buildStreamUrl(channel.id, video.slug);
    const response = await fetch(url, { headers: { Range: 'bytes=5-14' } });

    // 206 proves range handling belongs to storage — the API only redirected.
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 5-14/${PAYLOAD.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      PAYLOAD.subarray(5, 15),
    );
  });

  it('should serve the download url as an attachment named after the original file', async () => {
    const channel = await createChannel();
    const video = await seedReadyVideo(channel.id);

    const url = await service.buildDownloadUrl(channel.id, video.slug);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my holiday.mp4"',
    );
  });

  it('should not set a download disposition on the stream url', async () => {
    const channel = await createChannel();
    const video = await seedReadyVideo(channel.id);

    const url = await service.buildStreamUrl(channel.id, video.slug);
    const response = await fetch(url);

    // Playback must render inline; an attachment header would download it.
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('should refuse a slug that belongs to another channel exactly as an unknown slug', async () => {
    const owner = await createChannel();
    const stranger = await createChannel();
    const video = await seedReadyVideo(owner.id);

    const foreign: unknown = await service
      .buildStreamUrl(stranger.id, video.slug)
      .catch((e: unknown) => e);
    const unknown: unknown = await service
      .buildStreamUrl(stranger.id, 'nosuchslug')
      .catch((e: unknown) => e);

    expect(foreign).toBeInstanceOf(VideoNotFoundException);
    expect(unknown).toBeInstanceOf(VideoNotFoundException);
    expect((foreign as Error).message).toBe((unknown as Error).message);
  });

  it('should stop honouring the delivery url once it expires', async () => {
    const channel = await createChannel();
    const video = await seedReadyVideo(channel.id);

    // The service always signs with the short delivery expiry; this asserts the
    // storage really enforces it, using a deliberately tiny window.
    const url = await storage.presignGetObject(
      config.videosBucket,
      `${video.id}/source`,
      { expiresIn: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const response = await fetch(url);
    expect(response.status).toBe(403);
  }, 20000);
});
