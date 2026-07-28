import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';

interface VideoBody {
  id?: string;
  slug?: string;
  title?: string;
  original_filename?: string;
  processing_status?: string;
  visibility?: string;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  format_name?: string | null;
  size_bytes?: number | null;
  bitrate?: number | null;
  failure_reason?: string | null;
  created_at?: string;
  channel_id?: string;
  upload_id?: string;
  error?: string;
}

function body(res: { body: unknown }): VideoBody {
  return res.body as VideoBody;
}

/** Big enough for a meaningful `Range: bytes=0-1023` request. */
const PAYLOAD = Buffer.alloc(4096, 'streamtube-payload-');

/** The eight fields the worker fills in and that are null until it runs. */
const METADATA_FIELDS = [
  'duration_seconds',
  'width',
  'height',
  'video_codec',
  'audio_codec',
  'format_name',
  'size_bytes',
  'bitrate',
] as const;

describe('videos-delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let config: { videosBucket: string; publicEndpoint: string };
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    storage = moduleFixture.get(StorageService);
    config = moduleFixture.get<{
      videosBucket: string;
      publicEndpoint: string;
    }>(storageConfig.KEY);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });

    return (res.body as { access_token: string }).access_token;
  }

  async function channelForEmail(email: string): Promise<Channel> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    return channelRepository.findOneByOrFail({ user_id: user.id });
  }

  let counter = 0;

  /**
   * Seeds a video row directly. Only the `ready` case puts an object in the
   * bucket — the other states have nothing deliverable by definition.
   */
  async function seedVideo(
    channelId: string,
    status: VideoProcessingStatus,
    originalFilename = 'my holiday.mp4',
  ): Promise<Video> {
    counter += 1;
    const isReady = status === VideoProcessingStatus.READY;

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channelId,
        slug: `dlv${counter}${Date.now().toString(36)}`.slice(0, 16),
        title: 'Test video',
        original_filename: originalFilename,
        declared_mime: 'video/mp4',
        declared_size_bytes: PAYLOAD.length,
        processing_status: status,
        ...(isReady
          ? {
              duration_seconds: 12,
              width: 640,
              height: 360,
              video_codec: 'h264',
              audio_codec: 'aac',
              format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
              size_bytes: PAYLOAD.length,
              bitrate: 250_000,
            }
          : {}),
        ...(status === VideoProcessingStatus.FAILED
          ? { failure_reason: 'unsupported_container' }
          : {}),
      }),
    );

    if (isReady) {
      await storage.putObject(
        config.videosBucket,
        `${video.id}/source`,
        PAYLOAD,
        'video/mp4',
      );
    }

    return video;
  }

  // 1. Autenticação e propriedade

  it('returns 401 on all three routes without a token', async () => {
    const email = 'delivery-401@example.com';
    await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.READY);

    await request(app.getHttpServer()).get(`/videos/${video.slug}`).expect(401);
    await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/videos/${video.slug}/download`)
      .expect(401);
  });

  it('answers a video of another channel exactly as it answers an unknown slug', async () => {
    const tokenA = await registerConfirmAndLogin('delivery-a@example.com');
    await registerConfirmAndLogin('delivery-b@example.com');
    const channelB = await channelForEmail('delivery-b@example.com');
    const videoOfB = await seedVideo(channelB.id, VideoProcessingStatus.READY);

    const foreign = await request(app.getHttpServer())
      .get(`/videos/${videoOfB.slug}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
    const unknown = await request(app.getHttpServer())
      .get('/videos/naoexiste00')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    expect(body(foreign).error).toBe('VIDEO_NOT_FOUND');
    // Byte-identical, not merely same-status: any difference between the two
    // would let a caller probe which slugs of other channels are real.
    expect(foreign.text).toBe(unknown.text);
  });

  // 2. Leitura do próprio vídeo

  it('returns 200 with the metadata of a ready video and no internal fields', async () => {
    const email = 'delivery-read-ready@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(body(res).id).toBe(video.id);
    expect(body(res).slug).toBe(video.slug);
    expect(body(res).title).toBe('Test video');
    expect(body(res).original_filename).toBe('my holiday.mp4');
    expect(body(res).processing_status).toBe('ready');
    expect(body(res).visibility).toBe('draft');
    for (const field of METADATA_FIELDS) {
      expect(body(res)[field]).not.toBeNull();
    }

    // Neither the object key nor the multipart handle may leak, and the
    // response obviously carries no video bytes.
    expect(res.text).not.toContain('/source');
    expect(body(res).upload_id).toBeUndefined();
    expect(body(res).channel_id).toBeUndefined();
    expect(res.text.length).toBeLessThan(PAYLOAD.length);
  });

  it('returns 200 with null metadata while the video is still processing', async () => {
    const email = 'delivery-read-processing@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(body(res).processing_status).toBe('processing');
    for (const field of METADATA_FIELDS) {
      expect(body(res)[field]).toBeNull();
    }
  });

  it('exposes the failure reason of a failed video through a 200, not an error status', async () => {
    const email = 'delivery-read-failed@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.FAILED);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(body(res).processing_status).toBe('failed');
    // Reading a video that failed to process is a successful read; the failure
    // is data, and this is the only channel through which it reaches a client.
    expect(body(res).failure_reason).toBe('unsupported_container');
  });

  // 3. Streaming

  it('redirects a ready video to a presigned url that the storage serves, honouring Range', async () => {
    const email = 'delivery-stream@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(302);

    const location = res.headers['location'];
    // Signed with the public endpoint: the Compose service name resolves only
    // inside the Docker network, so a browser could never open it.
    expect(location.startsWith(config.publicEndpoint)).toBe(true);
    expect(location).not.toContain('//minio:');

    // The API's own body is Express's redirect stub, not the object: no video
    // byte ever passes through this process.
    expect(res.text.length).toBeLessThan(PAYLOAD.length);
    expect(res.text).not.toContain(PAYLOAD.subarray(0, 32).toString());

    const full = await fetch(location);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(PAYLOAD);

    const ranged = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${PAYLOAD.length}`,
    );
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
      PAYLOAD.subarray(0, 1024),
    );
  });

  it('refuses to stream a video that is not ready, with a code per reason', async () => {
    const email = 'delivery-stream-409@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);

    const processing = await seedVideo(
      channel.id,
      VideoProcessingStatus.PROCESSING,
    );
    const uploading = await seedVideo(
      channel.id,
      VideoProcessingStatus.UPLOADING,
    );
    const failed = await seedVideo(channel.id, VideoProcessingStatus.FAILED);

    const onProcessing = await request(app.getHttpServer())
      .get(`/videos/${processing.slug}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(body(onProcessing).error).toBe('VIDEO_NOT_READY');
    // A Location on an error response would be a delivery leak.
    expect(onProcessing.headers['location']).toBeUndefined();

    const onUploading = await request(app.getHttpServer())
      .get(`/videos/${uploading.slug}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(body(onUploading).error).toBe('VIDEO_NOT_READY');

    const onFailed = await request(app.getHttpServer())
      .get(`/videos/${failed.slug}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    // Distinct from NOT_READY: waiting will never make this one deliverable.
    expect(body(onFailed).error).toBe('VIDEO_PROCESSING_FAILED');
  });

  // 4. Download

  it('redirects a download to a presigned url the storage serves as an attachment', async () => {
    const email = 'delivery-download@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);
    const video = await seedVideo(channel.id, VideoProcessingStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.slug}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(302);

    const location = res.headers['location'];
    expect(location.startsWith(config.publicEndpoint)).toBe(true);
    expect(res.text.length).toBeLessThan(PAYLOAD.length);

    const downloaded = await fetch(location);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-disposition')).toBe(
      'attachment; filename="my holiday.mp4"',
    );
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(PAYLOAD);
  });

  it('refuses to hand out a download url for a video that is not ready', async () => {
    const email = 'delivery-download-409@example.com';
    const token = await registerConfirmAndLogin(email);
    const channel = await channelForEmail(email);

    const processing = await seedVideo(
      channel.id,
      VideoProcessingStatus.PROCESSING,
    );
    const failed = await seedVideo(channel.id, VideoProcessingStatus.FAILED);

    const onProcessing = await request(app.getHttpServer())
      .get(`/videos/${processing.slug}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(body(onProcessing).error).toBe('VIDEO_NOT_READY');

    const onFailed = await request(app.getHttpServer())
      .get(`/videos/${failed.slug}/download`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(body(onFailed).error).toBe('VIDEO_PROCESSING_FAILED');
  });
});
