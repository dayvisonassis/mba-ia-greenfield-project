import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { MAX_VIDEO_SIZE_BYTES } from './constants/accepted-video-formats';
import { VIDEO_PROCESSING_QUEUE } from './video-queue.constants';
import { VideoSlugService } from './video-slug.service';
import { VideosService, choosePartSize } from './videos.service';

const MIB = 1024 * 1024;

describe('VideosService.initiateUpload', () => {
  let service: VideosService;
  let createMultipartUpload: jest.Mock;
  let presignUploadPart: jest.Mock;
  let transaction: jest.Mock;
  let save: jest.Mock;

  beforeEach(async () => {
    createMultipartUpload = jest.fn().mockResolvedValue('upload-id-1');
    presignUploadPart = jest
      .fn()
      .mockImplementation((_b, _k, _u, partNumber: number) =>
        Promise.resolve(`https://storage.example/part/${partNumber}`),
      );
    save = jest.fn().mockImplementation((entity: unknown) => entity);
    transaction = jest
      .fn()
      .mockImplementation((cb: (m: unknown) => unknown) =>
        cb({ save, create: (_e: unknown, data: unknown) => data }),
      );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: DataSource, useValue: { transaction } },
        {
          provide: StorageService,
          useValue: { createMultipartUpload, presignUploadPart },
        },
        {
          provide: VideoSlugService,
          useValue: {
            generateUniqueSlug: jest.fn().mockResolvedValue('slug1'),
          },
        },
        {
          provide: storageConfig.KEY,
          useValue: { videosBucket: 'streamtube-videos' },
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('should reject a mime outside the allowlist without touching storage or the database', async () => {
    await expect(
      service.initiateUpload('channel-1', {
        original_filename: 'movie.mkv',
        declared_mime: 'video/x-matroska',
        declared_size_bytes: 1024,
      }),
    ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);

    // No row, no orphaned multipart — the check must come first.
    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('should reject a size above the ceiling without touching storage or the database', async () => {
    await expect(
      service.initiateUpload('channel-1', {
        original_filename: 'huge.mp4',
        declared_mime: 'video/mp4',
        declared_size_bytes: MAX_VIDEO_SIZE_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);

    expect(createMultipartUpload).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('should persist the draft row with the storage upload id', async () => {
    const result = await service.initiateUpload('channel-1', {
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: 12 * MIB,
    });

    const saveCalls = save.mock.calls as [Record<string, unknown>][];
    const saved = saveCalls[0][0];
    expect(saved.channel_id).toBe('channel-1');
    expect(saved.processing_status).toBe('uploading');
    expect(saved.visibility).toBe('draft');
    expect(saved.upload_id).toBe('upload-id-1');
    expect(saved.id).toBe(result.id);
  });

  it('should key the storage object on the video id with no extension', async () => {
    const result = await service.initiateUpload('channel-1', {
      original_filename: 'holiday.webm',
      declared_mime: 'video/webm',
      declared_size_bytes: 6 * MIB,
    });

    // The container lives in format_name and Content-Type, never in the key.
    expect(createMultipartUpload).toHaveBeenCalledWith(
      'streamtube-videos',
      `${result.id}/source`,
      'video/webm',
    );
  });

  it('should return one presigned url per part, covering the declared size', async () => {
    const declared = 12 * MIB; // 3 parts at the 5 MiB floor

    const result = await service.initiateUpload('channel-1', {
      original_filename: 'holiday.mp4',
      declared_mime: 'video/mp4',
      declared_size_bytes: declared,
    });

    expect(result.part_size_bytes).toBe(5 * MIB);
    expect(result.parts).toHaveLength(3);
    expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
    // Partitioning must cover the whole file, never leave a tail unassigned.
    expect(result.parts.length * result.part_size_bytes).toBeGreaterThanOrEqual(
      declared,
    );
  });
});

describe('VideosService.completeUpload', () => {
  let service: VideosService;
  let findOne: jest.Mock;
  let update: jest.Mock;
  let completeMultipartUpload: jest.Mock;
  let abortMultipartUpload: jest.Mock;
  let headObjectSize: jest.Mock;
  let queueAdd: jest.Mock;

  const uploadingVideo = {
    id: 'video-1',
    channel_id: 'channel-1',
    processing_status: 'uploading',
    upload_id: 'upload-id-1',
  };

  beforeEach(async () => {
    findOne = jest.fn().mockResolvedValue(uploadingVideo);
    update = jest.fn().mockResolvedValue(undefined);
    completeMultipartUpload = jest.fn().mockResolvedValue(undefined);
    abortMultipartUpload = jest.fn().mockResolvedValue(undefined);
    headObjectSize = jest.fn().mockResolvedValue(4096);
    queueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: DataSource,
          useValue: {
            getRepository: () => ({ findOne }),
            transaction: (cb: (m: unknown) => unknown) => cb({ update }),
          },
        },
        {
          provide: StorageService,
          useValue: {
            completeMultipartUpload,
            abortMultipartUpload,
            headObjectSize,
          },
        },
        { provide: VideoSlugService, useValue: {} },
        {
          provide: storageConfig.KEY,
          useValue: { videosBucket: 'streamtube-videos' },
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: queueAdd },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  const parts = [{ part_number: 1, etag: '"abc"' }];

  it('should refuse a video that is not in uploading, leaving it untouched', async () => {
    findOne.mockResolvedValue({
      ...uploadingVideo,
      processing_status: 'ready',
    });

    await expect(
      service.completeUpload('channel-1', 'video-1', { parts }),
    ).rejects.toBeInstanceOf(InvalidUploadStateException);

    expect(completeMultipartUpload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('should answer 404-shaped for a video of another channel', async () => {
    findOne.mockResolvedValue(null);

    await expect(
      service.completeUpload('channel-other', 'video-1', { parts }),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should map a storage rejection to INVALID_UPLOAD_PARTS and abort the multipart', async () => {
    completeMultipartUpload.mockRejectedValue(new Error('ETag mismatch'));

    await expect(
      service.completeUpload('channel-1', 'video-1', { parts }),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);

    // No orphaned multipart left behind on the irrecoverable path.
    expect(abortMultipartUpload).toHaveBeenCalledWith(
      'streamtube-videos',
      'video-1/source',
      'upload-id-1',
    );
    expect(update).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('should move the row to processing, clear upload_id and record the observed size', async () => {
    await service.completeUpload('channel-1', 'video-1', { parts });

    const updateCalls = update.mock.calls as [
      unknown,
      unknown,
      Record<string, unknown>,
    ][];
    expect(updateCalls[0][2]).toEqual({
      processing_status: 'processing',
      upload_id: null,
      // The size storage actually received, not the one the client declared.
      size_bytes: 4096,
    });
  });

  it('should enqueue the job only after the transaction callback has returned', async () => {
    const order: string[] = [];
    update.mockImplementation(() => {
      order.push('update');
      return Promise.resolve(undefined);
    });
    queueAdd.mockImplementation(() => {
      order.push('enqueue');
      return Promise.resolve({ id: 'job-1' });
    });

    await service.completeUpload('channel-1', 'video-1', { parts });

    // Enqueueing inside the transaction lets the worker read a row that has
    // not been committed — the race TD-08 calls out explicitly.
    expect(order).toEqual(['update', 'enqueue']);
    expect(queueAdd).toHaveBeenCalledWith('process-video', {
      videoId: 'video-1',
    });
  });
});

describe('choosePartSize', () => {
  it('should never return less than the 5 MiB protocol floor', () => {
    expect(choosePartSize(1)).toBe(5 * MIB);
    expect(choosePartSize(5 * MIB)).toBe(5 * MIB);
  });

  it('should keep the part count within the 10 000-part ceiling at max size', () => {
    const partSize = choosePartSize(MAX_VIDEO_SIZE_BYTES);
    const partCount = Math.ceil(MAX_VIDEO_SIZE_BYTES / partSize);

    expect(partSize).toBeGreaterThanOrEqual(5 * MIB);
    expect(partCount).toBeLessThanOrEqual(10_000);
  });

  it('should grow the part size when the floor would exceed the part ceiling', () => {
    // 100 GiB at 5 MiB parts would need 20 480 parts — over the limit.
    const huge = 100 * 1024 * MIB;
    const partSize = choosePartSize(huge);

    expect(partSize).toBeGreaterThan(5 * MIB);
    expect(Math.ceil(huge / partSize)).toBeLessThanOrEqual(10_000);
  });
});
