import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

const STORAGE_ENV = {
  STORAGE_ENDPOINT_INTERNAL: 'http://minio:9000',
  STORAGE_ENDPOINT_PUBLIC: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
  STORAGE_BUCKET_VIDEOS: 'streamtube-videos',
  STORAGE_BUCKET_THUMBNAILS: 'streamtube-thumbnails',
};

const QUEUE_ENV = {
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const ALL_KEYS = [...Object.keys(STORAGE_ENV), ...Object.keys(QUEUE_ENV)];

/**
 * These keys are `required()` in `env.validation.ts`, and `--runInBand` runs
 * every suite in one process sharing a single `process.env`. Deleting them in
 * teardown (the pattern `swagger.config.spec.ts` can afford, because
 * SWAGGER_ENABLED has a default) would leave every later suite that boots
 * AppModule failing Joi validation. So: snapshot, then restore.
 */
const originalEnv: Record<string, string | undefined> = {};

const restoreEnv = () => {
  for (const key of ALL_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
};

const loadConfigs = async (env: Record<string, string>) => {
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [storageConfig, queueConfig],
      }),
    ],
  }).compile();

  const storage = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  const queue = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return { storage, queue };
};

describe('storageConfig', () => {
  beforeAll(() => {
    for (const key of ALL_KEYS) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(restoreEnv);

  it('should map every storage env var onto the typed object', async () => {
    const { storage } = await loadConfigs(STORAGE_ENV);

    expect(storage).toEqual({
      internalEndpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      videosBucket: 'streamtube-videos',
      thumbnailsBucket: 'streamtube-thumbnails',
    });
  });

  it('should keep the internal endpoint distinct from the public one', async () => {
    const { storage } = await loadConfigs(STORAGE_ENV);

    // The whole point of two values: signing with the internal endpoint would
    // hand the browser a URL that only resolves inside the Docker network.
    expect(storage.internalEndpoint).not.toBe(storage.publicEndpoint);
  });

  it('should resolve the internal endpoint by Compose service name', async () => {
    const { storage } = await loadConfigs(STORAGE_ENV);

    expect(storage.internalEndpoint).toContain('minio');
    expect(storage.internalEndpoint).not.toContain('localhost');
  });

  it('should point the two buckets at different names', async () => {
    const { storage } = await loadConfigs(STORAGE_ENV);

    expect(storage.videosBucket).not.toBe(storage.thumbnailsBucket);
  });
});

describe('queueConfig', () => {
  beforeAll(() => {
    for (const key of ALL_KEYS) {
      originalEnv[key] = process.env[key];
    }
  });

  afterEach(restoreEnv);

  it('should map the redis env vars onto the typed object', async () => {
    const { queue } = await loadConfigs(QUEUE_ENV);

    expect(queue).toEqual({ host: 'redis', port: 6379 });
  });

  it('should parse REDIS_PORT as a number, not a string', async () => {
    const { queue } = await loadConfigs(QUEUE_ENV);

    expect(typeof queue.port).toBe('number');
  });
});
