import { registerAs } from '@nestjs/config';

/**
 * Redis connection backing the BullMQ video processing queue.
 *
 * Both keys are `required()` in `env.validation.ts`, so the non-null assertion
 * and the parse below hold: the app cannot boot with either one missing.
 */
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST!,
  port: parseInt(process.env.REDIS_PORT!, 10),
}));
