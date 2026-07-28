import type { JobsOptions } from 'bullmq';

/** Single queue, single job type, single consumer (per phase-03-videos/TD-01). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Processes one uploaded video: metadata, thumbnail, final status. */
export const PROCESS_VIDEO_JOB = 'process-video';

/** Reclaims multipart uploads the client abandoned (per TD-03 revision). */
export const SWEEP_ABANDONED_UPLOADS_JOB = 'sweep-abandoned-uploads';

/**
 * Identity of the repeatable-job scheduler behind the sweep. `upsertJobScheduler`
 * keys on it, which is what makes registering the schedule on every worker boot
 * idempotent instead of piling up duplicate schedules.
 */
export const ABANDONED_UPLOAD_SWEEP_SCHEDULER_ID = 'abandoned-upload-sweep';

/**
 * Payload is deliberately minimal: the handler re-reads state from the database
 * instead of trusting data captured when the job was created. That is BullMQ's
 * own idempotency guidance and removes the class of bug where a job carries
 * state that has since changed.
 */
export interface ProcessVideoJobData {
  videoId: string;
}

/** The sweep derives everything from storage, so it carries no payload. */
export type SweepAbandonedUploadsJobData = Record<string, never>;

/** Everything this queue can carry. The processor dispatches on `job.name`. */
export type VideoQueueJobData =
  | ProcessVideoJobData
  | SweepAbandonedUploadsJobData;

/**
 * Retry policy for transient failures — storage unavailable, timeouts, I/O.
 * Permanent failures (container outside the allowlist, no video stream) bypass
 * this entirely by throwing `UnrecoverableError`, which sends the job straight
 * to the `failed` set without spending attempts.
 */
export const VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
};
