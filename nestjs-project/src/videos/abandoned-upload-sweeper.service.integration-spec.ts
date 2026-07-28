import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { AbandonedUploadSweeperService } from './abandoned-upload-sweeper.service';
import { ABANDONED_UPLOAD_MIN_AGE_MS } from './constants/abandoned-upload-sweep';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';

/**
 * The sweep against real MinIO.
 *
 * MinIO stamps `Initiated` itself, so the age boundary cannot be crossed by
 * forging the upload's timestamp. It is crossed from the other side instead —
 * by moving the clock the sweep reads. That is precisely why `sweep()` takes a
 * `now`, and it exercises the real listing and the real abort.
 */
describe('AbandonedUploadSweeperService (integration)', () => {
  let module: TestingModule;
  let service: AbandonedUploadSweeperService;
  let storage: StorageService;
  let bucket: string;

  const createdUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [
        AbandonedUploadSweeperService,
        {
          // The schedule itself is unit-tested; here the queue only has to
          // absorb the registration so the module can initialise.
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { upsertJobScheduler: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    await module.init();

    service = module.get(AbandonedUploadSweeperService);
    storage = module.get(StorageService);
    bucket = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).videosBucket;
  });

  afterAll(async () => {
    for (const upload of createdUploads) {
      await storage
        .abortMultipartUpload(bucket, upload.key, upload.uploadId)
        .catch(() => undefined);
    }
    await module.close();
  });

  /** Opens a real multipart upload and remembers it for teardown. */
  async function openMultipart(key: string): Promise<string> {
    const uploadId = await storage.createMultipartUpload(
      bucket,
      key,
      'video/mp4',
    );
    createdUploads.push({ key, uploadId });
    return uploadId;
  }

  async function isInProgress(uploadId: string): Promise<boolean> {
    const uploads = await storage.listMultipartUploads(bucket);
    return uploads.some((upload) => upload.uploadId === uploadId);
  }

  it('should leave a freshly opened multipart untouched', async () => {
    const key = `sweep-fresh-${Date.now()}/source`;
    const uploadId = await openMultipart(key);

    await service.sweep(new Date());

    expect(await isInProgress(uploadId)).toBe(true);
  });

  it('should abort a multipart once it is past the threshold, and it disappears from the listing', async () => {
    const key = `sweep-stale-${Date.now()}/source`;
    const uploadId = await openMultipart(key);
    expect(await isInProgress(uploadId)).toBe(true);

    // One hour beyond the threshold, as observed from the sweep's clock.
    const future = new Date(
      Date.now() + ABANDONED_UPLOAD_MIN_AGE_MS + 3600_000,
    );
    const result = await service.sweep(future);

    expect(result.aborted).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    // The real point: the parts are gone from storage, not just counted.
    expect(await isInProgress(uploadId)).toBe(false);
  });

  it('should be safe to run twice — the second pass finds nothing left to abort', async () => {
    const key = `sweep-idempotent-${Date.now()}/source`;
    await openMultipart(key);

    const future = new Date(
      Date.now() + ABANDONED_UPLOAD_MIN_AGE_MS + 3600_000,
    );
    await service.sweep(future);
    const second = await service.sweep(future);

    // An hourly destructive job must not depend on being run exactly once.
    expect(second.aborted).toBe(0);
    expect(second.failed).toBe(0);
  });
});
