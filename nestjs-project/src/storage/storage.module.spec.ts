import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * DI wiring test. TypeScript cannot catch a missing `imports` entry or a wrong
 * provider token — those only blow up when the container resolves at runtime.
 *
 * `onModuleInit` is not triggered here: `.compile()` builds the container
 * without running lifecycle hooks, so no bucket bootstrap fires. The real
 * bootstrap against MinIO is exercised in the integration spec.
 */
describe('StorageModule', () => {
  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

  it('should compile and resolve StorageService', async () => {
    const module = await buildModule();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);

    await module.close();
  });

  it('should provide two distinct S3 clients', async () => {
    const module = await buildModule();

    const internal = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);

    expect(internal).toBeInstanceOf(S3Client);
    expect(publicClient).toBeInstanceOf(S3Client);
    expect(internal).not.toBe(publicClient);

    await module.close();
  });

  it('should build each client against its own endpoint, both path-style', async () => {
    const module = await buildModule();

    const internal = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);

    const internalEndpoint = await internal.config.endpoint!();
    const publicEndpoint = await publicClient.config.endpoint!();

    // The internal client must address the Compose service by name; the public
    // one must be a different host (its concrete value differs per environment
    // — localhost in dev, host.docker.internal when the suite runs in-container).
    expect(internalEndpoint.hostname).toBe('minio');
    expect(publicEndpoint.hostname).not.toBe('minio');
    expect(publicEndpoint.hostname).not.toBe(internalEndpoint.hostname);

    // Without forcePathStyle the SDK addresses buckets as `bucket.minio:9000`,
    // which does not resolve on the Compose network.
    expect(internal.config.forcePathStyle).toBe(true);
    expect(publicClient.config.forcePathStyle).toBe(true);

    await module.close();
  });
});
