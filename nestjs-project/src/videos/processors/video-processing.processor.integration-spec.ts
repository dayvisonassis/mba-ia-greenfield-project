import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { AbandonedUploadSweeperService } from '../abandoned-upload-sweeper.service';
import { Video } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../video-queue.constants';
import { VideosModule } from '../videos.module';
import { VideosService } from '../videos.service';
import { FfmpegAdapter } from './ffmpeg.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';
import {
  FAILURE_REASONS,
  VideoProcessingProcessor,
} from './video-processing.processor';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function jobFor(videoId: string): Job<ProcessVideoJobData> {
  return { data: { videoId } } as Job<ProcessVideoJobData>;
}

/**
 * The full processing path against real Postgres, real MinIO and the real
 * ffmpeg/ffprobe binaries — no mocks anywhere.
 */
describe('VideoProcessingProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessingProcessor;
  let videosService: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let config: ConfigType<typeof storageConfig>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let fixtureDir: string;

  const fixtures = { mp4: '', webm: '', avi: '', audioOnly: '' };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
        StorageModule,
      ],
      providers: [
        VideoProcessingProcessor,
        FfprobeAdapter,
        FfmpegAdapter,
        // The processor dispatches sweep jobs to it; this suite only exercises
        // the process-video path, so a stub keeps the sweep out of the way.
        {
          provide: AbandonedUploadSweeperService,
          useValue: { sweep: jest.fn() },
        },
      ],
    }).compile();
    await module.init();

    processor = module.get(VideoProcessingProcessor);
    videosService = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    config = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    fixtureDir = await mkdtemp(join(tmpdir(), 'processor-spec-'));
    const synth = (args: string[]) => execFileAsync('ffmpeg', ['-y', ...args]);
    const src = [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
    ];

    fixtures.mp4 = join(fixtureDir, 'valid.mp4');
    await synth([...src, '-pix_fmt', 'yuv420p', fixtures.mp4]);

    fixtures.webm = join(fixtureDir, 'valid.webm');
    await synth([...src, fixtures.webm]);

    fixtures.avi = join(fixtureDir, 'outside.avi');
    await synth([...src, fixtures.avi]);

    fixtures.audioOnly = join(fixtureDir, 'audio.mp4');
    await synth([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'aac',
      fixtures.audioOnly,
    ]);
  }, 180000);

  afterAll(async () => {
    try {
      await rm(fixtureDir, { recursive: true, force: true });
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
        email: `proc_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `proc_ch_${counter}`,
        user_id: user.id,
      }),
    );
  }

  /**
   * Runs a real initiate -> PUT -> complete cycle so the object sits in the
   * bucket exactly as production would leave it, then hands back the id.
   */
  async function uploadFixture(
    fixturePath: string,
    mime = 'video/mp4',
  ): Promise<string> {
    const channel = await createChannel();
    const payload = await readFile(fixturePath);

    const initiated = await videosService.initiateUpload(channel.id, {
      original_filename: 'fixture.bin',
      declared_mime: mime,
      declared_size_bytes: payload.length,
    });

    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    const etag = put.headers.get('etag')!;

    await videosService.completeUpload(channel.id, initiated.id, {
      parts: [{ part_number: 1, etag }],
    });

    return initiated.id;
  }

  it('should finish a real mp4 as ready with all eight metadata fields and a thumbnail', async () => {
    const videoId = await uploadFixture(fixtures.mp4);

    await processor.process(jobFor(videoId));

    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe('ready');
    expect(row.duration_seconds).toBe(2);
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);
    expect(row.video_codec).toBeTruthy();
    expect(row.format_name).toContain('mp4');
    expect(row.size_bytes).toBeGreaterThan(0);
    expect(row.bitrate).toBeGreaterThan(0);

    const thumbSize = await storage.headObjectSize(
      config.thumbnailsBucket,
      `${videoId}/default.jpg`,
    );
    expect(thumbSize).toBeGreaterThan(0);
  }, 120000);

  it('should take a real webm through the same path', async () => {
    const videoId = await uploadFixture(fixtures.webm, 'video/webm');

    await processor.process(jobFor(videoId));

    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe('ready');
    expect(row.format_name).toContain('webm');
  }, 120000);

  it('should end a container outside the allowlist as failed, permanently', async () => {
    // Declared as mp4 so initiation accepts it; ffprobe is the authority that
    // catches the lie (per TD-09).
    const videoId = await uploadFixture(fixtures.avi);

    await expect(processor.process(jobFor(videoId))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe('failed');
    expect(row.failure_reason).toBe(FAILURE_REASONS.UNSUPPORTED_CONTAINER);
  }, 120000);

  it('should end an accepted container with no video stream as failed', async () => {
    const videoId = await uploadFixture(fixtures.audioOnly);

    await expect(processor.process(jobFor(videoId))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe('failed');
    expect(row.failure_reason).toBe(FAILURE_REASONS.NO_VIDEO_STREAM);
  }, 120000);

  it('should not overwrite a ready video when the same job runs twice', async () => {
    const videoId = await uploadFixture(fixtures.mp4);

    await processor.process(jobFor(videoId));
    const first = await videoRepository.findOneByOrFail({ id: videoId });

    // Second delivery of the same job — at-least-once makes this routine.
    await processor.process(jobFor(videoId));
    const second = await videoRepository.findOneByOrFail({ id: videoId });

    expect(second.processing_status).toBe('ready');
    expect(second.updated_at.getTime()).toBe(first.updated_at.getTime());
  }, 120000);

  it('should leave the video out of failed when the storage read fails transiently', async () => {
    const videoId = await uploadFixture(fixtures.mp4);

    const downloadSpy = jest
      .spyOn(storage, 'downloadToFile')
      .mockRejectedValueOnce(new Error('connection reset'));

    try {
      const error: unknown = await processor
        .process(jobFor(videoId))
        .catch((e: unknown) => e);

      // Retryable, so the job returns to the queue instead of dying.
      expect(error).not.toBeInstanceOf(UnrecoverableError);
    } finally {
      downloadSpy.mockRestore();
    }

    const row = await videoRepository.findOneByOrFail({ id: videoId });
    expect(row.processing_status).toBe('processing');
    expect(row.failure_reason).toBeNull();
  }, 120000);
});
