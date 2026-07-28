import { writeFile } from 'fs/promises';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import { AbandonedUploadSweeperService } from '../abandoned-upload-sweeper.service';
import { Video } from '../entities/video.entity';
import {
  SWEEP_ABANDONED_UPLOADS_JOB,
  type ProcessVideoJobData,
  type VideoQueueJobData,
} from '../video-queue.constants';
import { FfmpegAdapter } from './ffmpeg.adapter';
import { FfprobeAdapter, type VideoMetadata } from './ffprobe.adapter';
import {
  FAILURE_REASONS,
  VideoProcessingProcessor,
} from './video-processing.processor';

const VIDEO_ID = '11111111-2222-3333-4444-555555555555';

const validMetadata: VideoMetadata = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration_seconds: 12,
  width: 1920,
  height: 1080,
  video_codec: 'h264',
  audio_codec: 'aac',
  size_bytes: 4096,
  bitrate: 2500,
  hasVideoStream: true,
};

function jobFor(videoId = VIDEO_ID): Job<ProcessVideoJobData> {
  return { data: { videoId } } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let findOneBy: jest.Mock;
  let update: jest.Mock;
  let downloadToFile: jest.Mock;
  let putObject: jest.Mock;
  let probe: jest.Mock;
  let extractThumbnail: jest.Mock;
  let sweep: jest.Mock;

  beforeEach(async () => {
    sweep = jest
      .fn()
      .mockResolvedValue({ inspected: 0, aborted: 0, failed: 0 });
    findOneBy = jest
      .fn()
      .mockResolvedValue({ id: VIDEO_ID, processing_status: 'processing' });
    update = jest.fn().mockResolvedValue(undefined);
    downloadToFile = jest.fn().mockResolvedValue(undefined);
    putObject = jest.fn().mockResolvedValue(undefined);
    probe = jest.fn().mockResolvedValue(validMetadata);
    // The real adapter produces a file on disk and the processor reads it back,
    // so the mock has to do the same — otherwise the read fails on a path the
    // test itself never created.
    extractThumbnail = jest
      .fn()
      .mockImplementation(async (_input: string, output: string) => {
        await writeFile(output, Buffer.from('fake-jpeg'));
      });

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOneBy, update },
        },
        {
          provide: StorageService,
          useValue: { downloadToFile, putObject },
        },
        { provide: FfprobeAdapter, useValue: { probe } },
        { provide: FfmpegAdapter, useValue: { extractThumbnail } },
        { provide: AbandonedUploadSweeperService, useValue: { sweep } },
        {
          provide: storageConfig.KEY,
          useValue: {
            videosBucket: 'streamtube-videos',
            thumbnailsBucket: 'streamtube-thumbnails',
          },
        },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('idempotency guard', () => {
    it.each(['ready', 'failed'])(
      'should do nothing when the video is already %s',
      async (status) => {
        findOneBy.mockResolvedValue({
          id: VIDEO_ID,
          processing_status: status,
        });

        await processor.process(jobFor());

        // Delivery is at-least-once: a redelivered job must not re-run the
        // work, re-upload a thumbnail or overwrite metadata.
        expect(downloadToFile).not.toHaveBeenCalled();
        expect(putObject).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      },
    );

    it('should fail permanently when the row no longer exists', async () => {
      findOneBy.mockResolvedValue(null);

      // No retry can bring a deleted row back.
      await expect(processor.process(jobFor())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });
  });

  describe('acceptance check', () => {
    it('should fail permanently and record the reason for a container outside the allowlist', async () => {
      probe.mockResolvedValue({ ...validMetadata, format_name: 'avi' });

      await expect(processor.process(jobFor())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          processing_status: 'failed',
          failure_reason: FAILURE_REASONS.UNSUPPORTED_CONTAINER,
        },
      );
      // Permanent failure never produces a thumbnail.
      expect(putObject).not.toHaveBeenCalled();
    });

    it('should fail permanently for an accepted container with no video stream', async () => {
      probe.mockResolvedValue({ ...validMetadata, hasVideoStream: false });

      await expect(processor.process(jobFor())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          processing_status: 'failed',
          failure_reason: FAILURE_REASONS.NO_VIDEO_STREAM,
        },
      );
    });
  });

  describe('transient failure', () => {
    it('should let a storage error propagate as a retryable error', async () => {
      downloadToFile.mockRejectedValue(new Error('connection reset'));

      const error: unknown = await processor
        .process(jobFor())
        .catch((e: unknown) => e);

      // NOT UnrecoverableError: the job must go back to the queue with
      // backoff, and the video must not be marked failed.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('should write the thumbnail to the private thumbnails bucket', async () => {
      await processor.process(jobFor());

      expect(putObject).toHaveBeenCalledWith(
        'streamtube-thumbnails',
        `${VIDEO_ID}/default.jpg`,
        expect.anything(),
        'image/jpeg',
      );
    });

    it('should persist the eight metadata fields and mark ready', async () => {
      await processor.process(jobFor());

      expect(update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          processing_status: 'ready',
          duration_seconds: 12,
          width: 1920,
          height: 1080,
          video_codec: 'h264',
          audio_codec: 'aac',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          size_bytes: 4096,
          bitrate: 2500,
        },
      );
    });

    it('should read the source from the videos bucket by the id-derived key', async () => {
      await processor.process(jobFor());

      const [bucket, key] = downloadToFile.mock.calls[0] as [string, string];
      expect(bucket).toBe('streamtube-videos');
      // The key never carries the client filename or an extension.
      expect(key).toBe(`${VIDEO_ID}/source`);
    });
  });

  describe('job dispatch', () => {
    it('should route a sweep job to the sweeper and never touch a video', async () => {
      const sweepJob = {
        name: SWEEP_ABANDONED_UPLOADS_JOB,
        data: {},
      } as Job<VideoQueueJobData>;

      await processor.process(sweepJob);

      expect(sweep).toHaveBeenCalledTimes(1);
      // Both job types share one queue and one worker, so the dispatch is the
      // only thing keeping a sweep from being read as a video id.
      expect(findOneBy).not.toHaveBeenCalled();
      expect(downloadToFile).not.toHaveBeenCalled();
    });

    it('should route any other job to video processing', async () => {
      await processor.process(jobFor());

      expect(sweep).not.toHaveBeenCalled();
      expect(findOneBy).toHaveBeenCalledWith({ id: VIDEO_ID });
    });
  });
});
