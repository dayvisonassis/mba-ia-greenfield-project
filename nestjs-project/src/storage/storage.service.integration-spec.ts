import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Runs against the real MinIO from the Compose stack — no mocks. The queue,
 * worker and storage of this phase are required to be real services, so the
 * tests that prove the storage contract talk to the real thing.
 */
describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  let client: S3Client;
  let config: ConfigType<typeof storageConfig>;

  const createdKeys: string[] = [];
  const uniqueKey = (suffix: string) =>
    `integration-tests/${Date.now()}-${Math.random().toString(36).slice(2)}/${suffix}`;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    // init() runs onModuleInit, which is the bucket bootstrap under test.
    await module.init();

    service = module.get(StorageService);
    client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    config = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
  });

  afterAll(async () => {
    try {
      for (const key of createdKeys) {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.videosBucket, Key: key }),
        );
      }
    } finally {
      // A DataSource or client left open keeps the event loop alive and Jest
      // never exits; --forceExit is a safety net, not a substitute.
      await module.close();
    }
  });

  describe('bucket bootstrap', () => {
    it('should have created both buckets', async () => {
      await expect(
        client.send(new HeadBucketCommand({ Bucket: config.videosBucket })),
      ).resolves.toBeDefined();
      await expect(
        client.send(new HeadBucketCommand({ Bucket: config.thumbnailsBucket })),
      ).resolves.toBeDefined();
    });

    it('should be idempotent when run again', async () => {
      // The app restarts constantly in watch mode; a second boot must not fail.
      await expect(service.bootstrapBuckets()).resolves.toBeUndefined();
      await expect(service.bootstrapBuckets()).resolves.toBeUndefined();
    });
  });

  describe('listMultipartUploads', () => {
    it('should see an in-progress multipart upload and stop seeing it after the abort', async () => {
      const key = uniqueKey('sweepable.bin');

      const uploadId = await service.createMultipartUpload(
        config.videosBucket,
        key,
        'application/octet-stream',
      );

      const before = await service.listMultipartUploads(config.videosBucket);
      const found = before.find((upload) => upload.uploadId === uploadId);

      expect(found).toBeDefined();
      expect(found!.key).toBe(key);
      // The sweep selects by age, so the timestamp is load-bearing, not decorative.
      expect(found!.initiatedAt).toBeInstanceOf(Date);

      await service.abortMultipartUpload(config.videosBucket, key, uploadId);

      const after = await service.listMultipartUploads(config.videosBucket);
      expect(
        after.find((upload) => upload.uploadId === uploadId),
      ).toBeUndefined();
    });
  });

  describe('presigned URLs', () => {
    it('should sign against the public endpoint, never the Compose service name', async () => {
      const url = await service.presignGetObject(
        config.videosBucket,
        uniqueKey('never-written'),
      );

      const publicHost = new URL(config.publicEndpoint).host;
      expect(new URL(url).host).toBe(publicHost);
      expect(url).not.toContain('minio:9000');
    });

    it('should round-trip an object through putObject and a presigned GET', async () => {
      const key = uniqueKey('round-trip.bin');
      createdKeys.push(key);
      const payload = Buffer.from('streamtube round-trip payload');

      await service.putObject(
        config.videosBucket,
        key,
        payload,
        'application/octet-stream',
      );

      const url = await service.presignGetObject(config.videosBucket, key);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    });

    it('should complete a multipart upload from a presigned part URL', async () => {
      const key = uniqueKey('multipart.bin');
      createdKeys.push(key);
      // A single part may be under the 5 MiB floor — the floor exempts the last
      // part, and with one part it is also the last.
      const payload = Buffer.from('multipart payload written by the client');

      const uploadId = await service.createMultipartUpload(
        config.videosBucket,
        key,
        'application/octet-stream',
      );
      const partUrl = await service.presignUploadPart(
        config.videosBucket,
        key,
        uploadId,
        1,
      );

      // This PUT is what the browser does: the bytes go straight to storage and
      // never transit the API process.
      const partResponse = await fetch(partUrl, {
        method: 'PUT',
        body: new Uint8Array(payload),
      });
      expect(partResponse.status).toBe(200);

      const etag = partResponse.headers.get('etag');
      expect(etag).toBeTruthy();

      await service.completeMultipartUpload(
        config.videosBucket,
        key,
        uploadId,
        [{ partNumber: 1, etag: etag! }],
      );

      const head = await client.send(
        new HeadObjectCommand({ Bucket: config.videosBucket, Key: key }),
      );
      expect(head.ContentLength).toBe(payload.length);
    });

    it('should abort a multipart upload', async () => {
      const key = uniqueKey('aborted.bin');

      const uploadId = await service.createMultipartUpload(
        config.videosBucket,
        key,
        'application/octet-stream',
      );

      await expect(
        service.abortMultipartUpload(config.videosBucket, key, uploadId),
      ).resolves.toBeUndefined();
    });

    it('should stop honouring a presigned URL once it has expired', async () => {
      const key = uniqueKey('expiring.bin');
      createdKeys.push(key);

      await service.putObject(
        config.videosBucket,
        key,
        Buffer.from('expires quickly'),
        'application/octet-stream',
      );

      const url = await service.presignGetObject(config.videosBucket, key, {
        expiresIn: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await fetch(url);
      expect(response.status).toBe(403);
    });
  });

  describe('bucket privacy', () => {
    it('should refuse an unsigned request to an object in either bucket', async () => {
      const key = uniqueKey('private.bin');
      createdKeys.push(key);

      await service.putObject(
        config.videosBucket,
        key,
        Buffer.from('private payload'),
        'application/octet-stream',
      );

      const unsigned = `${config.publicEndpoint}/${config.videosBucket}/${key}`;
      const videoResponse = await fetch(unsigned);
      expect(videoResponse.status).toBe(403);

      const thumbnailResponse = await fetch(
        `${config.publicEndpoint}/${config.thumbnailsBucket}/${key}`,
      );
      expect(thumbnailResponse.status).toBe(403);
    });
  });
});
