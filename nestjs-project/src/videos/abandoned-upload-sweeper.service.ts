import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  ABANDONED_UPLOAD_MIN_AGE_MS,
  ABANDONED_UPLOAD_SWEEP_INTERVAL_MS,
} from './constants/abandoned-upload-sweep';
import {
  ABANDONED_UPLOAD_SWEEP_SCHEDULER_ID,
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoQueueJobData,
} from './video-queue.constants';

/** What one sweep did, so the caller and the tests can assert on it. */
export interface SweepResult {
  inspected: number;
  aborted: number;
  failed: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Reclaims multipart uploads a client opened and never completed.
 *
 * Without this their parts sit in the bucket consuming storage that no listing
 * of objects reveals — an in-progress multipart is not an object yet. The
 * original design was a bucket lifecycle rule; MinIO does not implement
 * `AbortIncompleteMultipartUpload`, so the same guarantee is provided here
 * (per phase-03-videos/TD-03 revision).
 */
@Injectable()
export class AbandonedUploadSweeperService implements OnModuleInit {
  private readonly logger = new Logger(AbandonedUploadSweeperService.name);

  constructor(
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoQueueJobData>,
  ) {}

  /**
   * Registers the hourly schedule on the queue that already exists, rather than
   * introducing a scheduler of its own (per phase-03-videos/TD-01): BullMQ was
   * chosen so that recurrence is configuration.
   *
   * `upsertJobScheduler` keys on the scheduler id, so every worker boot — and
   * every replica — converges on the same single schedule instead of adding one.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      ABANDONED_UPLOAD_SWEEP_SCHEDULER_ID,
      { every: ABANDONED_UPLOAD_SWEEP_INTERVAL_MS },
      {
        name: SWEEP_ABANDONED_UPLOADS_JOB,
        data: {},
        // No retries: a failed sweep is repeated by the next tick an hour
        // later, and retrying would only re-list the same bucket sooner.
        opts: { attempts: 1, removeOnComplete: true },
      },
    );
  }

  /**
   * Aborts every in-progress multipart older than the threshold.
   *
   * `now` is a parameter so the age boundary can be exercised without waiting a
   * day — production always calls it with no argument.
   */
  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const uploads = await this.storage.listMultipartUploads(
      this.config.videosBucket,
    );

    const result: SweepResult = {
      inspected: uploads.length,
      aborted: 0,
      failed: 0,
    };

    for (const upload of uploads) {
      const ageMs = now.getTime() - upload.initiatedAt.getTime();
      if (ageMs < ABANDONED_UPLOAD_MIN_AGE_MS) {
        continue;
      }

      const ageHours = (ageMs / MS_PER_HOUR).toFixed(1);

      try {
        await this.storage.abortMultipartUpload(
          this.config.videosBucket,
          upload.key,
          upload.uploadId,
        );
        result.aborted += 1;
        // The sweep destroys data the client cannot recover, so every abort
        // leaves an auditable trace of what was reclaimed and how old it was.
        this.logger.log(
          `Aborted abandoned multipart ${upload.uploadId} for key ${upload.key} — age ${ageHours}h`,
        );
      } catch (error) {
        // One unreclaimable upload must not stop the ones after it, and this
        // runs in a background job where rethrowing would only lose the rest of
        // the batch. The next hourly tick tries again.
        result.failed += 1;
        this.logger.error(
          `Failed to abort multipart ${upload.uploadId} for key ${upload.key} — age ${ageHours}h: ${String(error)}`,
        );
      }
    }

    return result;
  }
}
