import { envValidationSchema } from './env.validation';

/**
 * A complete set of the keys the schema marks `required()`. Each test below
 * removes exactly one of the new storage/queue keys and asserts the schema
 * names it — this is what guarantees the AC "booting without one of the new
 * env vars fails with a Joi message naming the missing key".
 */
const completeEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT_INTERNAL: 'http://minio:9000',
  STORAGE_ENDPOINT_PUBLIC: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
  STORAGE_BUCKET_VIDEOS: 'streamtube-videos',
  STORAGE_BUCKET_THUMBNAILS: 'streamtube-thumbnails',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });

const withoutKey = (key: string): Record<string, string> => {
  const env = { ...completeEnv };
  delete (env as Record<string, string>)[key];
  return env;
};

const NEW_REQUIRED_KEYS = [
  'STORAGE_ENDPOINT_INTERNAL',
  'STORAGE_ENDPOINT_PUBLIC',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_BUCKET_VIDEOS',
  'STORAGE_BUCKET_THUMBNAILS',
  'REDIS_HOST',
  'REDIS_PORT',
];

describe('envValidationSchema — storage and queue keys', () => {
  it('should accept a complete environment', () => {
    const { error } = validate(completeEnv);
    expect(error).toBeUndefined();
  });

  it.each(NEW_REQUIRED_KEYS)(
    'should reject an environment missing %s, naming the key',
    (key) => {
      const { error } = validate(withoutKey(key));
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject a non-URI storage endpoint', () => {
    const { error } = validate({
      ...completeEnv,
      STORAGE_ENDPOINT_INTERNAL: 'not-a-uri',
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT_INTERNAL');
  });

  it('should reject a REDIS_PORT outside the valid port range', () => {
    const { error } = validate({ ...completeEnv, REDIS_PORT: '99999' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
