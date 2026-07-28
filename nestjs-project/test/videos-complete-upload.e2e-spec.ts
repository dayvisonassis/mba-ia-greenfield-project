import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/video-queue.constants';
import { VideosService } from '../src/videos/videos.service';

interface CompleteBody {
  id?: string;
  slug?: string;
  processing_status?: string;
  statusCode?: number;
  error?: string;
  message?: string | string[];
}

function body(res: { body: unknown }): CompleteBody {
  return res.body as CompleteBody;
}

/** A video seeded in `uploading` with its single part already in storage. */
interface SeededUpload {
  id: string;
  parts: { part_number: number; etag: string }[];
}

describe('videos-complete-upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let videosService: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let bucket: string;
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
    videosService = moduleFixture.get(VideosService);
    storage = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    bucket = moduleFixture.get<{ videosBucket: string }>(
      storageConfig.KEY,
    ).videosBucket;
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    try {
      // Anything still open would otherwise sit in the bucket as orphaned parts.
      const leftovers = await storage.listMultipartUploads(bucket);
      for (const upload of leftovers) {
        await storage.abortMultipartUpload(bucket, upload.key, upload.uploadId);
      }
    } finally {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
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

  /**
   * Seeds a video in `uploading` with its part already PUT to storage, so the
   * only thing left for a test is the completion call itself.
   */
  async function seedUpload(channelId: string): Promise<SeededUpload> {
    const payload = Buffer.from('a part uploaded by the client');
    const initiated = await videosService.initiateUpload(channelId, {
      original_filename: 'clip.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: payload.length,
    });

    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(payload),
    });
    const etag = put.headers.get('etag')!;

    return { id: initiated.id, parts: [{ part_number: 1, etag }] };
  }

  async function jobsFor(videoId: string) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.filter(
      (job) => (job.data as { videoId: string }).videoId === videoId,
    );
  }

  // 1. Autenticação e propriedade
  it('returns 401 without a token, leaving the video in uploading and the queue empty', async () => {
    const token = await registerConfirmAndLogin('complete1@example.com');
    const channel = await channelForEmail('complete1@example.com');
    void token;
    const seeded = await seedUpload(channel.id);

    await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .send({ parts: seeded.parts })
      .expect(401);

    const row = await videoRepository.findOneByOrFail({ id: seeded.id });
    expect(row.processing_status).toBe('uploading');
    await expect(jobsFor(seeded.id)).resolves.toHaveLength(0);
  });

  it('returns 404 VIDEO_NOT_FOUND for a video of another channel, never 403', async () => {
    const tokenA = await registerConfirmAndLogin('complete-a@example.com');
    await registerConfirmAndLogin('complete-b@example.com');
    const channelB = await channelForEmail('complete-b@example.com');

    const seeded = await seedUpload(channelB.id);

    const res = await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ parts: seeded.parts })
      .expect(404);

    // A 403 would confirm the resource exists and allow enumerating ids.
    expect(body(res).error).toBe('VIDEO_NOT_FOUND');

    const row = await videoRepository.findOneByOrFail({ id: seeded.id });
    expect(row.processing_status).toBe('uploading');
    expect(row.upload_id).not.toBeNull();
    await expect(jobsFor(seeded.id)).resolves.toHaveLength(0);
  });

  // 2. Conclusão bem-sucedida
  it('returns 202 with processing_status and enqueues exactly one job', async () => {
    const token = await registerConfirmAndLogin('complete2@example.com');
    const channel = await channelForEmail('complete2@example.com');
    const seeded = await seedUpload(channel.id);

    const res = await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: seeded.parts })
      .expect(202);

    expect(body(res).id).toBe(seeded.id);
    expect(body(res).slug).toBeDefined();
    expect(body(res).processing_status).toBe('processing');

    const row = await videoRepository.findOneByOrFail({ id: seeded.id });
    expect(row.processing_status).toBe('processing');
    expect(row.upload_id).toBeNull();

    // The object survived the completion intact.
    const size = await storage.headObjectSize(bucket, `${seeded.id}/source`);
    expect(size).toBeGreaterThan(0);

    const jobs = await jobsFor(seeded.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('process-video');
  });

  it('has the row committed by the time the job is readable from the queue', async () => {
    const token = await registerConfirmAndLogin('complete3@example.com');
    const channel = await channelForEmail('complete3@example.com');
    const seeded = await seedUpload(channel.id);

    await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: seeded.parts })
      .expect(202);

    // This is what a consumer does: take the videoId off the job and read the
    // row. If enqueue had happened inside the transaction, this lookup would
    // find the row still in `uploading` — or not find it at all.
    const jobs = await jobsFor(seeded.id);
    expect(jobs).toHaveLength(1);

    const videoIdFromJob = (jobs[0].data as { videoId: string }).videoId;
    const row = await videoRepository.findOneByOrFail({ id: videoIdFromJob });
    expect(row.processing_status).toBe('processing');
  });

  // 3. Estado inválido e partes inválidas
  it('returns 409 INVALID_UPLOAD_STATE on a second completion and does not enqueue twice', async () => {
    const token = await registerConfirmAndLogin('complete4@example.com');
    const channel = await channelForEmail('complete4@example.com');
    const seeded = await seedUpload(channel.id);

    await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: seeded.parts })
      .expect(202);

    const res = await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: seeded.parts })
      .expect(409);

    expect(body(res).error).toBe('INVALID_UPLOAD_STATE');
    await expect(jobsFor(seeded.id)).resolves.toHaveLength(1);
  });

  it('returns 409 INVALID_UPLOAD_PARTS on a divergent etag and does not advance the video', async () => {
    const token = await registerConfirmAndLogin('complete5@example.com');
    const channel = await channelForEmail('complete5@example.com');
    const seeded = await seedUpload(channel.id);

    const res = await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: [{ part_number: 1, etag: '"0000000000000000000000000000dead"' }],
      })
      .expect(409);

    expect(body(res).error).toBe('INVALID_UPLOAD_PARTS');

    const row = await videoRepository.findOneByOrFail({ id: seeded.id });
    expect(row.processing_status).toBe('uploading');
    await expect(jobsFor(seeded.id)).resolves.toHaveLength(0);
  });

  // 4. Validação de schema
  it('returns 400 for a non-uuid id and for an empty parts array', async () => {
    const token = await registerConfirmAndLogin('complete6@example.com');
    const channel = await channelForEmail('complete6@example.com');
    const seeded = await seedUpload(channel.id);

    const notUuid = await request(app.getHttpServer())
      .post('/videos/nao-e-uuid/complete')
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: seeded.parts })
      .expect(400);
    expect(body(notUuid).statusCode).toBe(400);

    await request(app.getHttpServer())
      .post(`/videos/${seeded.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [] })
      .expect(400);
  });
});
