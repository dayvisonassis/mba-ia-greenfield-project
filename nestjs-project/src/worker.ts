import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VideoProcessingModule } from './videos/processors/video-processing.module';

/**
 * Entrypoint of the `video-worker` container.
 *
 * `createApplicationContext` — not `create` — because the worker has no HTTP
 * surface: it exists to consume the `video-processing` queue. Booting a server
 * would open a port nothing calls.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoProcessingModule);

  // Lets the module's shutdown hooks run: @nestjs/bullmq closes each worker and
  // then the queue, so a job in flight is not abandoned mid-processing.
  app.enableShutdownHooks();

  Logger.log('Video worker started', 'Worker');
}

void bootstrap();
