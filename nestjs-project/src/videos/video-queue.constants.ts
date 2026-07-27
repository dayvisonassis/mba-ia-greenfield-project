import type { JobsOptions } from 'bullmq';

/** Single queue, single job type, single consumer (per phase-03-videos/TD-01). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** The only job name on this queue. */
export const PROCESS_VIDEO_JOB = 'process-video';

/**
 * Payload is deliberately minimal: the handler re-reads state from the database
 * instead of trusting data captured when the job was created. That is BullMQ's
 * own idempotency guidance and removes the class of bug where a job carries
 * state that has since changed.
 */
export interface ProcessVideoJobData {
  videoId: string;
}

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
