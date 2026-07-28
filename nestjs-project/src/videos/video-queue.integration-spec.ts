import { Queue, UnrecoverableError, Worker } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-queue.constants';

/**
 * Runs against the real Redis from the Compose stack — no mocks. The queue is
 * required to be a real service in this phase, so the tests that prove the
 * queue contract talk to the real thing.
 *
 * Every test uses an isolated queue name so a failure never leaves jobs behind
 * for the next one.
 */
describe('video-processing queue (integration)', () => {
  const config = queueConfig();
  const connection = { host: config.host, port: config.port };

  let queues: Queue[] = [];
  let workers: Worker[] = [];

  function makeQueue(name: string): Queue {
    const queue = new Queue(name, {
      connection,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    });
    queues.push(queue);
    return queue;
  }

  function makeWorker(
    name: string,
    // Sync is allowed: the failure-path handlers only throw, and forcing them
    // async would trip require-await for no gain.
    handler: (data: ProcessVideoJobData) => void | Promise<void>,
  ): Worker<ProcessVideoJobData> {
    const worker = new Worker<ProcessVideoJobData>(
      name,
      async (job) => {
        await handler(job.data);
      },
      { connection },
    );
    workers.push(worker);
    return worker;
  }

  afterEach(async () => {
    // Workers first: close() waits for active jobs, and a worker still holding
    // one blocks the queue's own shutdown. --forceExit is a safety net in the
    // scripts, not a substitute for closing here.
    try {
      for (const worker of workers) {
        await worker.close();
      }
      for (const queue of queues) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    } finally {
      workers = [];
      queues = [];
    }
  });

  it('should read back a job with the payload that was written', async () => {
    const queue = makeQueue(`${VIDEO_PROCESSING_QUEUE}-payload-test`);
    const payload: ProcessVideoJobData = {
      videoId: '11111111-2222-3333-4444-555555555555',
    };

    const added = await queue.add(PROCESS_VIDEO_JOB, payload);
    const stored = await queue.getJob(added.id!);

    expect(stored).toBeDefined();
    expect(stored!.name).toBe(PROCESS_VIDEO_JOB);
    expect(stored!.data).toEqual(payload);
  });

  it('should carry the retry policy onto every job by default', async () => {
    const queue = makeQueue(`${VIDEO_PROCESSING_QUEUE}-opts-test`);

    const job = await queue.add(PROCESS_VIDEO_JOB, { videoId: 'abc' });

    // The options come from the queue, not from each call site — otherwise a
    // producer that forgets them silently loses retry.
    expect(job.opts.attempts).toBe(VIDEO_JOB_OPTIONS.attempts);
    expect(job.opts.backoff).toEqual(VIDEO_JOB_OPTIONS.backoff);
  });

  it('should retry a failing job up to attempts and then move it to failed', async () => {
    const name = `${VIDEO_PROCESSING_QUEUE}-retry-test`;
    const queue = makeQueue(name);
    let calls = 0;

    const worker = makeWorker(name, () => {
      calls += 1;
      throw new Error('transient boom');
    });

    const failed = new Promise<void>((resolve) => {
      worker.on('failed', (job) => {
        // 'failed' fires per attempt; resolve only when retries are exhausted.
        if (job && job.attemptsMade >= (VIDEO_JOB_OPTIONS.attempts ?? 0)) {
          resolve();
        }
      });
    });

    // Short backoff so the test does not wait on the production delay curve.
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: 'retry-me' },
      { backoff: { type: 'fixed', delay: 10 } },
    );
    await failed;

    expect(calls).toBe(VIDEO_JOB_OPTIONS.attempts);
    await expect(queue.getJobCounts('failed')).resolves.toMatchObject({
      failed: 1,
    });
  }, 20000);

  it('should send an UnrecoverableError straight to failed without spending attempts', async () => {
    const name = `${VIDEO_PROCESSING_QUEUE}-permanent-test`;
    const queue = makeQueue(name);
    let calls = 0;

    const worker = makeWorker(name, () => {
      calls += 1;
      throw new UnrecoverableError('container outside allowlist');
    });

    const failed = new Promise<void>((resolve) => {
      worker.on('failed', () => resolve());
    });

    await queue.add(PROCESS_VIDEO_JOB, { videoId: 'permanent' });
    await failed;

    // This is the mechanism TD-09 relies on for inputs outside the allowlist:
    // one attempt, no retry, straight to the dead-letter (the `failed` set).
    expect(calls).toBe(1);
    await expect(queue.getJobCounts('failed')).resolves.toMatchObject({
      failed: 1,
    });
  }, 20000);
});
