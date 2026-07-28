import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideoSlugService } from './video-slug.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * DI wiring test. TypeScript cannot catch a missing `imports` entry or a wrong
 * queue token — those only surface when the container resolves at runtime.
 */
describe('VideosModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        // VideosModule pulls in StorageModule, so storageConfig must be loaded
        // here too — otherwise the S3 client providers cannot resolve.
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        VideosModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    // Closing the module closes the Bull connection; without it the ioredis
    // socket keeps the event loop alive and Jest never exits on its own.
    await module.close();
  });

  it('should compile and resolve VideoSlugService', () => {
    expect(module.get(VideoSlugService)).toBeInstanceOf(VideoSlugService);
  });

  it('should resolve the Video repository token', () => {
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
  });

  it('should resolve the video-processing queue by its injection token', () => {
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  });
});
