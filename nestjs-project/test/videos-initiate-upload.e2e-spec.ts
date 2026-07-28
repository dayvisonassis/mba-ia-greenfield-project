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
import { Video } from '../src/videos/entities/video.entity';

const MIB = 1024 * 1024;
const MAX_SIZE = 10 * 1024 * MIB;

/** Supertest types `body` as `any`; this is the shape this suite asserts on. */
interface InitiateBody {
  id?: string;
  slug?: string;
  upload_id?: string;
  part_size_bytes?: number;
  parts?: { part_number: number; url: string }[];
  expires_in?: number;
  statusCode?: number;
  error?: string;
  message?: string | string[];
}

function body(res: { body: unknown }): InitiateBody {
  return res.body as InitiateBody;
}

describe('videos-initiate-upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let bucket: string;
  let throttlerStorage: ThrottlerStorageService;

  const openedUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Test.createTestingModule does not run main.ts — the global pipe and
    // filters must be reproduced here or the error envelope never applies.
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
    bucket = moduleFixture.get<{ videosBucket: string }>(
      storageConfig.KEY,
    ).videosBucket;
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    try {
      // Leave no multipart behind for the SI-03.16 sweep to find.
      for (const { key, uploadId } of openedUploads) {
        await storage.abortMultipartUpload(bucket, key, uploadId);
      }
    } finally {
      await app.close();
    }
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

  const validPayload = {
    original_filename: 'holiday.mp4',
    declared_mime: 'video/mp4',
    declared_size_bytes: 12 * MIB,
  };

  function trackUpload(res: { body: unknown }): void {
    const b = body(res);
    if (b.id && b.upload_id) {
      openedUploads.push({ key: `${b.id}/source`, uploadId: b.upload_id });
    }
  }

  // 1. Autenticação
  it('returns 401 without an Authorization header and creates no row', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validPayload)
      .expect(401);

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  // 2. Iniciação bem-sucedida
  it('returns 201 with presigned parts on a valid body', async () => {
    const token = await registerConfirmAndLogin('initiate1@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload)
      .expect(201);
    trackUpload(res);

    const b = body(res);
    expect(b.id).toBeDefined();
    expect(b.slug).toBeDefined();
    expect(b.upload_id).toBeDefined();
    expect(b.expires_in).toBeGreaterThan(0);

    expect(b.part_size_bytes).toBeGreaterThanOrEqual(5 * MIB);
    expect(b.parts!.length).toBeGreaterThan(0);
    for (const part of b.parts!) {
      expect(part.part_number).toBeGreaterThanOrEqual(1);
      // The client resolves these, so they must never carry the Compose name.
      expect(part.url).not.toContain('minio:9000');
    }
    // Partitioning must cover the whole declared size.
    expect(b.parts!.length * b.part_size_bytes!).toBeGreaterThanOrEqual(
      validPayload.declared_size_bytes,
    );

    const row = await videoRepository.findOneByOrFail({ id: b.id! });
    expect(row.processing_status).toBe('uploading');
    expect(row.visibility).toBe('draft');
    expect(row.upload_id).toBe(b.upload_id);
  });

  it('accepts video/webm as well, not only mp4', async () => {
    const token = await registerConfirmAndLogin('initiate2@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, declared_mime: 'video/webm' })
      .expect(201);
    trackUpload(res);

    await expect(videoRepository.count()).resolves.toBe(1);
  });

  it('always owns the video by the token channel, never by a channel_id in the body', async () => {
    const tokenA = await registerConfirmAndLogin('owner-a@example.com');
    await registerConfirmAndLogin('owner-b@example.com');

    // Resolve through the user, not a guessed nickname: sanitizeNickname
    // strips characters outside [a-z0-9_], so the email prefix is not the
    // nickname verbatim.
    const channelB = await channelForEmail('owner-b@example.com');

    // The global ValidationPipe runs with forbidNonWhitelisted, so an unknown
    // `channel_id` is rejected outright rather than silently stripped. Either
    // way the AC holds — ownership can never come from the body — but the
    // observable outcome is 400, not the 201 the spec scenario assumed.
    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ ...validPayload, channel_id: channelB.id })
      .expect(400);

    await expect(videoRepository.count()).resolves.toBe(0);

    // And the honest half of the claim: a clean request is owned by the
    // token's channel, not by anything the caller could influence.
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(validPayload)
      .expect(201);
    trackUpload(res);

    const channelA = await channelForEmail('owner-a@example.com');
    const row = await videoRepository.findOneByOrFail({ id: body(res).id! });
    expect(row.channel_id).toBe(channelA.id);
    expect(row.channel_id).not.toBe(channelB.id);
  });

  // 3. Rejeição por política de input
  it('returns 400 UNSUPPORTED_VIDEO_FORMAT for a mime outside the allowlist', async () => {
    const token = await registerConfirmAndLogin('initiate3@example.com');
    const before = await storage.listMultipartUploads(bucket);

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, declared_mime: 'video/x-matroska' })
      .expect(400);

    expect(body(res).statusCode).toBe(400);
    expect(body(res).message).toBeDefined();
    await expect(videoRepository.count()).resolves.toBe(0);

    // No orphaned multipart: the declaration is checked before storage is
    // touched at all.
    const after = await storage.listMultipartUploads(bucket);
    expect(after).toHaveLength(before.length);
  });

  it('returns 400 for a declared size above the 10 GiB ceiling', async () => {
    const token = await registerConfirmAndLogin('initiate4@example.com');

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, declared_size_bytes: MAX_SIZE + 1 })
      .expect(400);

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  // 4. Validação de schema
  it('returns a 400 validation error in the shared envelope when a field is missing', async () => {
    const token = await registerConfirmAndLogin('initiate5@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        original_filename: 'holiday.mp4',
        declared_size_bytes: 12 * MIB,
      })
      .expect(400);

    const b = body(res);
    expect(b.statusCode).toBe(400);
    expect(b.error).toBeDefined();
    expect(JSON.stringify(b.message)).toContain('declared_mime');
  });

  it('returns 400 when the declared size is zero', async () => {
    const token = await registerConfirmAndLogin('initiate6@example.com');

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, declared_size_bytes: 0 })
      .expect(400);

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  // 5. Título do rascunho
  it('stores the supplied title on the pre-registered draft', async () => {
    const token = await registerConfirmAndLogin('initiate7@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, title: 'Ferias 2026' })
      .expect(201);
    trackUpload(res);

    const row = await videoRepository.findOneByOrFail({ id: body(res).id! });
    expect(row.title).toBe('Ferias 2026');
  });

  it('derives a title from the filename when the client sends none', async () => {
    const token = await registerConfirmAndLogin('initiate8@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload)
      .expect(201);
    trackUpload(res);

    // The draft is pre-registered automatically, so it must be presentable
    // without the client having supplied anything beyond the file itself.
    const row = await videoRepository.findOneByOrFail({ id: body(res).id! });
    expect(row.title).toBe('holiday');
  });
});
