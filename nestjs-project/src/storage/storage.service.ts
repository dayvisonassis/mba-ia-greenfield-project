import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  PRESIGN_EXPIRES_IN_SECONDS,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';

/** One completed part, as the client reports it back on upload completion. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/** A multipart upload that was started and neither completed nor aborted. */
export interface InProgressUpload {
  uploadId: string;
  key: string;
  initiatedAt: Date;
}

export interface PresignGetOptions {
  expiresIn?: number;
  /** Sets `Content-Disposition` on the response — used to force a download. */
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrapBuckets();
  }

  /**
   * Creates both buckets if absent and installs the abandoned-multipart
   * lifecycle rule. Idempotent on purpose: it runs on every boot, and the app
   * restarts constantly in watch mode.
   *
   * Neither bucket gets a public policy — MinIO buckets are private by default
   * and this phase keeps them that way, including thumbnails. Everything is
   * reached through presigned URLs behind an ownership check.
   */
  async bootstrapBuckets(): Promise<void> {
    await this.ensureBucket(this.config.videosBucket);
    await this.ensureBucket(this.config.thumbnailsBucket);
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    try {
      await this.internalClient.send(
        new CreateBucketCommand({ Bucket: bucket }),
      );
      this.logger.log(`Created bucket "${bucket}"`);
    } catch (error) {
      // Two boots racing each other both see "absent" and both create. The
      // loser gets this and it is not a failure — the bucket exists either way.
      if (!isAlreadyOwned(error)) {
        throw error;
      }
    }
  }

  /**
   * Every multipart upload that was started and neither completed nor aborted.
   *
   * This is the read half of the abandoned-upload sweep (SI-03.16); the write
   * half is `abortMultipartUpload` above. A bucket lifecycle rule would have
   * been the obvious mechanism, but the MinIO this phase runs does not
   * implement `AbortIncompleteMultipartUpload` — it rejects the rule when that
   * is the only action and silently drops the action when paired with another.
   *
   * The listing is paginated: S3 returns at most 1000 uploads per call and
   * signals more via `IsTruncated`. Reading only the first page would leave
   * orphaned parts behind with no error — exactly the failure the sweep exists
   * to prevent — so this walks every page.
   */
  async listMultipartUploads(bucket: string): Promise<InProgressUpload[]> {
    const uploads: InProgressUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    do {
      const response = await this.internalClient.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of response.Uploads ?? []) {
        if (upload.UploadId && upload.Key && upload.Initiated) {
          uploads.push({
            uploadId: upload.UploadId,
            key: upload.Key,
            initiatedAt: upload.Initiated,
          });
        }
      }

      keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
      uploadIdMarker = response.IsTruncated
        ? response.NextUploadIdMarker
        : undefined;
    } while (keyMarker !== undefined || uploadIdMarker !== undefined);

    return uploads;
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(
        `Storage did not return an UploadId for "${bucket}/${key}"`,
      );
    }

    return response.UploadId;
  }

  /**
   * Signs a single part. The client PUTs the bytes straight at this URL — no
   * video byte ever transits the Node process.
   */
  async presignUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = PRESIGN_EXPIRES_IN_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Signs a GET. Delivery redirects the client here, so `Range`/`206` is
   * handled by the storage and not by the API.
   */
  async presignGetObject(
    bucket: string,
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: options.expiresIn ?? PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  /**
   * Size of a stored object, as the storage reports it. Upload completion uses
   * this to record the size actually received rather than trusting the size the
   * client declared at initiation.
   */
  async headObjectSize(bucket: string, key: string): Promise<number> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return response.ContentLength ?? 0;
  }

  /**
   * Streams an object onto local disk through the INTERNAL client.
   *
   * The worker needs the file on disk for ffprobe/ffmpeg. Handing them a
   * presigned URL instead would break: those are signed with the PUBLIC
   * endpoint, which in development is `localhost:9000` and resolves to the
   * worker container itself, not to storage.
   */
  async downloadToFile(
    bucket: string,
    key: string,
    destinationPath: string,
  ): Promise<void> {
    const response = await this.internalClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`Storage returned no body for "${bucket}/${key}"`);
    }

    await pipeline(
      response.Body as NodeJS.ReadableStream,
      createWriteStream(destinationPath),
    );
  }

  /** Server-side write — used by the worker for the generated thumbnail. */
  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}

const isNotFound = (error: unknown): boolean =>
  hasName(error, 'NotFound') || httpStatus(error) === 404;

const isAlreadyOwned = (error: unknown): boolean =>
  hasName(error, 'BucketAlreadyOwnedByYou') ||
  hasName(error, 'BucketAlreadyExists');

const hasName = (error: unknown, name: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name: unknown }).name === name;

const httpStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode;
};
