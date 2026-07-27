import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  InvalidUploadPartsException,
  InvalidUploadStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { StorageService } from '../storage/storage.service';
import {
  MAX_VIDEO_SIZE_BYTES,
  isAcceptedVideoMime,
} from './constants/accepted-video-formats';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-queue.constants';
import {
  Video,
  VideoProcessingStatus,
  VideoVisibility,
} from './entities/video.entity';
import { VideoSlugService } from './video-slug.service';

/** S3 protocol floor for every part except the last. */
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** S3 protocol ceiling on how many parts one multipart upload may have. */
const MAX_PARTS = 10_000;

/**
 * Lifetime of the presigned `UploadPart` URLs. Deliberately longer than the
 * delivery URLs of TD-07 (minutes): those gate reads of an existing object,
 * while these must stay valid for as long as the client is still pushing
 * bytes. A 10 GiB upload over a modest link runs for a long time, and this
 * phase ships no endpoint to re-issue part URLs mid-flight.
 */
const UPLOAD_URL_EXPIRES_IN_SECONDS = 3600;

export interface PresignedPart {
  part_number: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  slug: string;
  upload_id: string;
  part_size_bytes: number;
  parts: PresignedPart[];
  expires_in: number;
}

/**
 * Chooses the smallest legal part size: the 5 MiB floor, unless the file is
 * large enough that 5 MiB parts would exceed the 10 000-part ceiling.
 */
export function choosePartSize(declaredSizeBytes: number): number {
  return Math.max(
    MIN_PART_SIZE_BYTES,
    Math.ceil(declaredSizeBytes / MAX_PARTS),
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly slugService: VideoSlugService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Opens a multipart upload and pre-registers the video as a draft. No byte of
   * the file passes through this process — the client PUTs each part straight
   * at the presigned URLs returned here (per phase-03-videos/TD-03).
   */
  async initiateUpload(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (!isAcceptedVideoMime(dto.declared_mime)) {
      throw new UnsupportedVideoFormatException(dto.declared_mime);
    }
    if (dto.declared_size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    // The object key derives from the video id, so the id must exist before the
    // multipart is opened. Generating it here keeps the whole initiation to a
    // single INSERT that already carries `upload_id`.
    const id = randomUUID();
    const key = `${id}/source`;

    // Opened before the transaction: holding a DB transaction open across a
    // network round-trip to storage is a good way to exhaust the pool. If the
    // transaction below fails, this multipart is orphaned — which is exactly
    // what the SI-03.16 sweep reclaims.
    const uploadId = await this.storage.createMultipartUpload(
      this.config.videosBucket,
      key,
      dto.declared_mime,
    );

    const slug = await this.dataSource.transaction(async (manager) => {
      const generated = await this.slugService.generateUniqueSlug(manager);

      await manager.save(
        manager.create(Video, {
          id,
          channel_id: channelId,
          slug: generated,
          original_filename: dto.original_filename,
          declared_mime: dto.declared_mime,
          declared_size_bytes: dto.declared_size_bytes,
          processing_status: VideoProcessingStatus.UPLOADING,
          visibility: VideoVisibility.DRAFT,
          upload_id: uploadId,
        }),
      );

      return generated;
    });

    const partSize = choosePartSize(dto.declared_size_bytes);
    const partCount = Math.ceil(dto.declared_size_bytes / partSize);

    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          this.config.videosBucket,
          key,
          uploadId,
          partNumber,
          UPLOAD_URL_EXPIRES_IN_SECONDS,
        ),
      });
    }

    return {
      id,
      slug,
      upload_id: uploadId,
      part_size_bytes: partSize,
      parts,
      expires_in: UPLOAD_URL_EXPIRES_IN_SECONDS,
    };
  }

  /**
   * Closes the multipart with the ETags the client collected, moves the video
   * to `processing` and enqueues the job.
   *
   * The ordering here is the whole point of this method: the job is enqueued
   * **after** the transaction commits. Enqueueing inside the transaction lets
   * the worker pick up the job and query a row that has not been committed yet
   * — a race that reproduces rarely and passes a badly written test (per
   * phase-03-videos/TD-08).
   */
  async completeUpload(
    channelId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<void> {
    const video = await this.dataSource.getRepository(Video).findOne({
      where: { id: videoId, channel_id: channelId },
    });
    // 404 for "not yours" as well as "does not exist" — a 403 would confirm the
    // row exists and allow enumerating other channels' videos.
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.processing_status !== VideoProcessingStatus.UPLOADING) {
      throw new InvalidUploadStateException();
    }
    if (!video.upload_id) {
      throw new InvalidUploadStateException();
    }

    const key = `${video.id}/source`;

    try {
      await this.storage.completeMultipartUpload(
        this.config.videosBucket,
        key,
        video.upload_id,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch {
      // Irrecoverable: the reported parts do not match what storage holds, and
      // no retry of the same payload will fix it. Abort so the multipart does
      // not sit there accumulating orphaned parts.
      await this.abortQuietly(key, video.upload_id);
      throw new InvalidUploadPartsException();
    }

    const observedSize = await this.storage.headObjectSize(
      this.config.videosBucket,
      key,
    );

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Video,
        { id: video.id },
        {
          processing_status: VideoProcessingStatus.PROCESSING,
          upload_id: null,
          size_bytes: observedSize,
        },
      );
    });

    // --- Transaction has committed. Only now may the job become observable. ---
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId: video.id });
  }

  /**
   * Best-effort cleanup on the failure path. Swallowing here is deliberate and
   * narrow: the caller is already throwing a domain exception, and letting an
   * abort failure replace it would hide the real cause. Anything this misses is
   * reclaimed by the abandoned-upload sweep.
   */
  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(
        this.config.videosBucket,
        key,
        uploadId,
      );
    } catch (abortError) {
      this.logger.warn(
        `Failed to abort multipart ${uploadId} for ${key}; the sweep will reclaim it: ${String(abortError)}`,
      );
    }
  }
}
