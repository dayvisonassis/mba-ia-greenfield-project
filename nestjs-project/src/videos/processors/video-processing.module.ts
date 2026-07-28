import { Module } from '@nestjs/common';
import { ConfigRootModule, TypeOrmRootModule } from '../../config/root-modules';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../../users/users.module';
import { AbandonedUploadSweeperService } from '../abandoned-upload-sweeper.service';
import { VideosModule } from '../videos.module';
import { FfmpegAdapter } from './ffmpeg.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Root module of the `video-worker` container (per phase-03-videos/TD-04).
 *
 * It boots the same configuration and database wiring as the HTTP app, plus
 * `VideosModule` — which is where the `video-processing` queue is registered.
 * Sharing that registration is the point: producer and consumer take the queue
 * name and job options from one definition instead of two that can drift.
 *
 * `UsersModule` is imported for its entity registration, not its services:
 * `autoLoadEntities` only discovers entities registered through `forFeature`,
 * and the relation graph the worker touches is `Video -> Channel -> User`.
 * Leaving `User` out fails at connection time with "Entity metadata for
 * Channel#user was not found" — at container start, far from the cause.
 *
 * No controllers and no HTTP surface: the worker is started as a Nest
 * application *context*, never as a server.
 */
@Module({
  // StorageModule is imported directly, not relied upon through VideosModule:
  // that module imports it but does not re-export it, so StorageService would
  // not be resolvable here — the processor reads the source object and writes
  // the thumbnail through it.
  imports: [
    ConfigRootModule,
    TypeOrmRootModule,
    VideosModule,
    UsersModule,
    StorageModule,
  ],
  // The sweeper is declared here and not in `VideosModule` on purpose: only the
  // worker container may run it. Registering it where the API can reach it
  // would put a destructive hourly schedule in every API replica.
  providers: [
    VideoProcessingProcessor,
    FfprobeAdapter,
    FfmpegAdapter,
    AbandonedUploadSweeperService,
  ],
})
export class VideoProcessingModule {}
