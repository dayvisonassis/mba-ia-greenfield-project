import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  InvalidUploadPartsException,
  InvalidUploadStateException,
} from '../common/exceptions/domain.exception';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIB = 1024 * 1024;

/**
 * Runs against the real Postgres and the real MinIO from the Compose stack.
 */
describe('VideosService.initiateUpload (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let config: ConfigType<typeof storageConfig>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  const openedUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
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
    try {
      // Leave no multipart behind for the sweep to find.
      for (const { key, uploadId } of openedUploads) {
        await storage.abortMultipartUpload(config.videosBucket, key, uploadId);
      }
    } finally {
      await module.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `initiate_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `initiate_ch_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should create exactly one draft row with the storage upload id', async () => {
    const channel = await createChannel();

    const result = await service.initiateUpload(channel.id, {
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: 12 * MIB,
    });
    openedUploads.push({
      key: `${result.id}/source`,
      uploadId: result.upload_id,
    });

    const rows = await videoRepository.findBy({ channel_id: channel.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0].processing_status).toBe('uploading');
    expect(rows[0].visibility).toBe('draft');
    expect(rows[0].upload_id).toBe(result.upload_id);
    expect(rows[0].slug).toBe(result.slug);
  });

  it('should open a real multipart upload visible to listMultipartUploads', async () => {
    const channel = await createChannel();

    const result = await service.initiateUpload(channel.id, {
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: 8 * MIB,
    });
    openedUploads.push({
      key: `${result.id}/source`,
      uploadId: result.upload_id,
    });

    const inProgress = await storage.listMultipartUploads(config.videosBucket);
    expect(
      inProgress.some((upload) => upload.uploadId === result.upload_id),
    ).toBe(true);
  });

  it('should create no row at all when the mime is outside the allowlist', async () => {
    const channel = await createChannel();

    await expect(
      service.initiateUpload(channel.id, {
        original_filename: 'movie.mkv',
        declared_mime: 'video/x-matroska',
        declared_size_bytes: 8 * MIB,
      }),
    ).rejects.toThrow();

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should sign every part url against the public endpoint, never the Compose service name', async () => {
    const channel = await createChannel();

    const result = await service.initiateUpload(channel.id, {
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: 12 * MIB,
    });
    openedUploads.push({
      key: `${result.id}/source`,
      uploadId: result.upload_id,
    });

    const publicHost = new URL(config.publicEndpoint).host;
    expect(result.parts).toHaveLength(3);
    for (const part of result.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
      expect(part.url).not.toContain('minio:9000');
    }
    expect(result.part_size_bytes).toBeGreaterThanOrEqual(5 * MIB);
  });

  describe('completeUpload', () => {
    /** Runs a full initiate → PUT part → complete cycle against real services. */
    async function uploadAndComplete(channelId: string, payload: Buffer) {
      const initiated = await service.initiateUpload(channelId, {
        original_filename: 'clip.mp4',
        declared_mime: 'video/mp4',
        declared_size_bytes: payload.length,
      });

      const put = await fetch(initiated.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(payload),
      });
      const etag = put.headers.get('etag')!;

      return { initiated, etag };
    }

    it('should leave the object intact and the row in processing with upload_id cleared', async () => {
      const channel = await createChannel();
      const payload = Buffer.from('the complete upload payload');

      const { initiated, etag } = await uploadAndComplete(channel.id, payload);
      await service.completeUpload(channel.id, initiated.id, {
        parts: [{ part_number: 1, etag }],
      });

      const row = await videoRepository.findOneByOrFail({ id: initiated.id });
      expect(row.processing_status).toBe('processing');
      expect(row.upload_id).toBeNull();
      // The size storage reports, not the one the client declared.
      expect(row.size_bytes).toBe(payload.length);

      const storedSize = await storage.headObjectSize(
        config.videosBucket,
        `${initiated.id}/source`,
      );
      expect(storedSize).toBe(payload.length);
    });

    it('should refuse a video that is not in uploading and leave it unchanged', async () => {
      const channel = await createChannel();
      const payload = Buffer.from('already completed');

      const { initiated, etag } = await uploadAndComplete(channel.id, payload);
      await service.completeUpload(channel.id, initiated.id, {
        parts: [{ part_number: 1, etag }],
      });

      // Second completion: the row is in `processing` now.
      await expect(
        service.completeUpload(channel.id, initiated.id, {
          parts: [{ part_number: 1, etag }],
        }),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      const row = await videoRepository.findOneByOrFail({ id: initiated.id });
      expect(row.processing_status).toBe('processing');
    });

    it('should reject a divergent etag and leave no multipart behind', async () => {
      const channel = await createChannel();
      const payload = Buffer.from('etag mismatch payload');

      const { initiated } = await uploadAndComplete(channel.id, payload);

      await expect(
        service.completeUpload(channel.id, initiated.id, {
          parts: [
            { part_number: 1, etag: '"0000000000000000000000000000dead"' },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      const row = await videoRepository.findOneByOrFail({ id: initiated.id });
      expect(row.processing_status).toBe('uploading');

      // The irrecoverable path aborts the multipart rather than leaking parts.
      const inProgress = await storage.listMultipartUploads(
        config.videosBucket,
      );
      expect(
        inProgress.some((upload) => upload.uploadId === initiated.upload_id),
      ).toBe(false);
    });

    it('should put a process-video job on the real queue', async () => {
      const channel = await createChannel();
      const payload = Buffer.from('queued payload');

      const { initiated, etag } = await uploadAndComplete(channel.id, payload);
      await service.completeUpload(channel.id, initiated.id, {
        parts: [{ part_number: 1, etag }],
      });

      const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
      const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
      const job = waiting.find(
        (candidate) =>
          (candidate.data as { videoId: string }).videoId === initiated.id,
      );

      expect(job).toBeDefined();
      expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    });
  });

  it('should produce part urls the storage actually accepts', async () => {
    const channel = await createChannel();
    const payload = Buffer.from('a real part uploaded by the client');

    const result = await service.initiateUpload(channel.id, {
      original_filename: 'small.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: payload.length,
    });

    // This PUT is what the browser does — the byte never enters this process.
    const response = await fetch(result.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    expect(response.status).toBe(200);

    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();

    await storage.completeMultipartUpload(
      config.videosBucket,
      `${result.id}/source`,
      result.upload_id,
      [{ partNumber: 1, etag: etag! }],
    );
  });
});
