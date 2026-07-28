import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { AbandonedUploadSweeperService } from './abandoned-upload-sweeper.service';
import {
  ABANDONED_UPLOAD_MIN_AGE_MS,
  ABANDONED_UPLOAD_SWEEP_INTERVAL_MS,
} from './constants/abandoned-upload-sweep';
import {
  ABANDONED_UPLOAD_SWEEP_SCHEDULER_ID,
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-queue.constants';

const BUCKET = 'streamtube-videos';
const NOW = new Date('2026-07-27T12:00:00Z');

/** `now` minus the given number of hours. */
function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

describe('AbandonedUploadSweeperService', () => {
  let service: AbandonedUploadSweeperService;
  let storage: {
    listMultipartUploads: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let queue: { upsertJobScheduler: jest.Mock };

  beforeEach(async () => {
    storage = {
      listMultipartUploads: jest.fn().mockResolvedValue([]),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbandonedUploadSweeperService,
        { provide: StorageService, useValue: storage },
        { provide: storageConfig.KEY, useValue: { videosBucket: BUCKET } },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(AbandonedUploadSweeperService);
  });

  describe('age selection', () => {
    it('should abort an upload older than the threshold', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        { uploadId: 'up-old', key: 'abc/source', initiatedAt: hoursAgo(30) },
      ]);

      const result = await service.sweep(NOW);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        BUCKET,
        'abc/source',
        'up-old',
      );
      expect(result).toEqual({ inspected: 1, aborted: 1, failed: 0 });
    });

    it('should preserve an upload younger than the threshold', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        { uploadId: 'up-young', key: 'def/source', initiatedAt: hoursAgo(2) },
      ]);

      const result = await service.sweep(NOW);

      // This is the case that protects a 10 GiB upload still in flight over a
      // slow link — aborting it destroys work the client cannot recover.
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(result).toEqual({ inspected: 1, aborted: 0, failed: 0 });
    });

    it('should abort an upload sitting exactly on the threshold', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        {
          uploadId: 'up-edge',
          key: 'ghi/source',
          initiatedAt: new Date(NOW.getTime() - ABANDONED_UPLOAD_MIN_AGE_MS),
        },
      ]);

      await service.sweep(NOW);

      // The rule is "at least 24h", so the boundary itself is inside the sweep.
      // Pinned deliberately: a millisecond of ambiguity here is the difference
      // between reclaiming an upload and destroying one still in flight.
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should preserve an upload one millisecond short of the threshold', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        {
          uploadId: 'up-just-young',
          key: 'jkl/source',
          initiatedAt: new Date(
            NOW.getTime() - ABANDONED_UPLOAD_MIN_AGE_MS + 1,
          ),
        },
      ]);

      await service.sweep(NOW);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should sort the old from the young within one batch', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        { uploadId: 'up-1', key: 'a/source', initiatedAt: hoursAgo(48) },
        { uploadId: 'up-2', key: 'b/source', initiatedAt: hoursAgo(1) },
        { uploadId: 'up-3', key: 'c/source', initiatedAt: hoursAgo(25) },
      ]);

      const result = await service.sweep(NOW);

      expect(result).toEqual({ inspected: 3, aborted: 2, failed: 0 });
      const abortedIds = (
        storage.abortMultipartUpload.mock.calls as [string, string, string][]
      ).map((call) => call[2]);
      expect(abortedIds).toEqual(['up-1', 'up-3']);
    });
  });

  describe('resilience and audit trail', () => {
    it('should keep sweeping after one abort fails', async () => {
      storage.listMultipartUploads.mockResolvedValue([
        { uploadId: 'up-bad', key: 'a/source', initiatedAt: hoursAgo(30) },
        { uploadId: 'up-good', key: 'b/source', initiatedAt: hoursAgo(30) },
      ]);
      storage.abortMultipartUpload.mockRejectedValueOnce(
        new Error('storage unavailable'),
      );

      const result = await service.sweep(NOW);

      // Rethrowing here would abandon every upload after the failing one, and
      // the next tick is an hour away.
      expect(result).toEqual({ inspected: 2, aborted: 1, failed: 1 });
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
    });

    it('should log each abort with the uploadId and the age', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      storage.listMultipartUploads.mockResolvedValue([
        { uploadId: 'up-old', key: 'abc/source', initiatedAt: hoursAgo(30) },
      ]);

      await service.sweep(NOW);

      const line = log.mock.calls[0][0] as string;
      expect(line).toContain('up-old');
      expect(line).toContain('abc/source');
      expect(line).toContain('30.0h');
      log.mockRestore();
    });

    it('should not call storage at all when nothing is in progress', async () => {
      const result = await service.sweep(NOW);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(result).toEqual({ inspected: 0, aborted: 0, failed: 0 });
    });
  });

  describe('schedule registration', () => {
    it('should upsert an hourly scheduler on the existing queue', async () => {
      await service.onModuleInit();

      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        ABANDONED_UPLOAD_SWEEP_SCHEDULER_ID,
        { every: ABANDONED_UPLOAD_SWEEP_INTERVAL_MS },
        expect.objectContaining({ name: SWEEP_ABANDONED_UPLOADS_JOB }),
      );
    });

    it('should schedule far more often than the age threshold', () => {
      // If the cadence ever exceeded the threshold, an upload could stay
      // abandoned for almost two full periods before being reclaimed.
      expect(ABANDONED_UPLOAD_SWEEP_INTERVAL_MS).toBeLessThan(
        ABANDONED_UPLOAD_MIN_AGE_MS,
      );
    });
  });
});
