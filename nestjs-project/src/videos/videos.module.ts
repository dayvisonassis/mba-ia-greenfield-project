import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import {
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';
import { VideoSlugService } from './video-slug.service';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';

/**
 * Owns the `Video` entity and the `video-processing` queue. Registering the
 * entity here is what makes it discoverable by `autoLoadEntities` — without an
 * owning module the app boots but every query against `videos` fails at
 * runtime, and `Channel`'s inverse relation cannot be resolved at all.
 *
 * The queue is registered here rather than in `AppModule` so that producer and
 * consumer share one definition: the `video-worker` container of TD-04 runs the
 * same codebase and imports this module to get the identical queue name and
 * job options.
 *
 * Controllers and the remaining services land in later SIs of this phase.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    }),
  ],
  controllers: [VideosController],
  providers: [VideoSlugService, VideosService],
  exports: [TypeOrmModule, BullModule, VideoSlugService, VideosService],
})
export class VideosModule {}
