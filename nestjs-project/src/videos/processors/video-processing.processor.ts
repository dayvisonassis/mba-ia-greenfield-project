import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import { AbandonedUploadSweeperService } from '../abandoned-upload-sweeper.service';
import { isAcceptedFormatName } from '../constants/accepted-video-formats';
import { Video, VideoProcessingStatus } from '../entities/video.entity';
import {
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
  type VideoQueueJobData,
} from '../video-queue.constants';
import { FfmpegAdapter } from './ffmpeg.adapter';
import { FfprobeAdapter } from './ffprobe.adapter';

/** Values written to `failure_reason` — the two permanent conditions of TD-09. */
export const FAILURE_REASONS = {
  UNSUPPORTED_CONTAINER: 'unsupported_container',
  NO_VIDEO_STREAM: 'no_video_stream',
} as const;

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffprobe: FfprobeAdapter,
    private readonly ffmpeg: FfmpegAdapter,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    private readonly sweeper: AbandonedUploadSweeperService,
  ) {
    super();
  }

  /**
   * Sole entry point of the queue's worker, so it dispatches by job name. One
   * `@Processor` per queue is the contract — a second class on the same queue
   * would spawn a second worker competing for the same jobs.
   */
  async process(job: Job<VideoQueueJobData>): Promise<void> {
    if (job.name === SWEEP_ABANDONED_UPLOADS_JOB) {
      const result = await this.sweeper.sweep();
      this.logger.log(
        `Abandoned-upload sweep: ${result.aborted} aborted, ${result.failed} failed, ${result.inspected} inspected`,
      );
      return;
    }

    // Narrowed by the name check above: every other job on this queue is a
    // process-video job.
    await this.processVideo((job.data as ProcessVideoJobData).videoId);
  }

  private async processVideo(videoId: string): Promise<void> {
    // --- Idempotency guard, first thing. Delivery is at-least-once: stall
    // detection re-queues jobs from a worker that died mid-processing, so a
    // second run of the same job is expected, not exceptional (per TD-08).
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      // The row is gone; retrying cannot bring it back.
      throw new UnrecoverableError(`Video ${videoId} no longer exists`);
    }
    if (
      video.processing_status === VideoProcessingStatus.READY ||
      video.processing_status === VideoProcessingStatus.FAILED
    ) {
      this.logger.log(
        `Video ${videoId} already ${video.processing_status}; skipping`,
      );
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const sourcePath = join(workDir, 'source');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      // Transient by nature: storage may be briefly unavailable. Letting this
      // throw normally is what sends the job back to the queue with backoff.
      await this.storage.downloadToFile(
        this.config.videosBucket,
        `${videoId}/source`,
        sourcePath,
      );

      const metadata = await this.ffprobe.probe(sourcePath);

      // --- Acceptance check (TD-09). Both conditions are PERMANENT failures:
      // no retry can make a WebM out of an AVI, or find a video stream that
      // is not there.
      if (!isAcceptedFormatName(metadata.format_name)) {
        await this.markFailed(videoId, FAILURE_REASONS.UNSUPPORTED_CONTAINER);
        throw new UnrecoverableError(
          `Container "${metadata.format_name}" is outside the allowlist`,
        );
      }
      if (!metadata.hasVideoStream) {
        await this.markFailed(videoId, FAILURE_REASONS.NO_VIDEO_STREAM);
        throw new UnrecoverableError('File carries no video stream');
      }

      await this.ffmpeg.extractThumbnail(
        sourcePath,
        thumbnailPath,
        metadata.duration_seconds,
      );
      await this.storage.putObject(
        this.config.thumbnailsBucket,
        `${videoId}/default.jpg`,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      await this.videoRepository.update(
        { id: videoId },
        {
          processing_status: VideoProcessingStatus.READY,
          duration_seconds: metadata.duration_seconds,
          width: metadata.width,
          height: metadata.height,
          video_codec: metadata.video_codec,
          audio_codec: metadata.audio_codec,
          format_name: metadata.format_name,
          size_bytes: metadata.size_bytes,
          bitrate: metadata.bitrate,
        },
      );
    } finally {
      // Runs on every path, including the UnrecoverableError ones — a 10 GiB
      // download left behind would fill the worker's disk within a few jobs.
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      {
        processing_status: VideoProcessingStatus.FAILED,
        failure_reason: reason,
      },
    );
  }
}
