import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-queue.constants';
import { VideoProcessingModule } from './video-processing.module';

/**
 * DI wiring test for the worker's root module. The worker runs in its own
 * container, so a missing import here fails at container start — far from
 * anything that would point at the cause.
 */
describe('VideoProcessingModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [VideoProcessingModule],
    }).compile();
  });

  afterAll(async () => {
    // Closes the Bull connection; without it the ioredis socket keeps the
    // event loop alive and Jest never exits on its own.
    await module.close();
  });

  it('should compile the worker root module', () => {
    expect(module).toBeDefined();
  });

  it('should resolve the video-processing queue the worker consumes', () => {
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  });

  it('should resolve the Video repository the processor writes through', () => {
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
  });
});
