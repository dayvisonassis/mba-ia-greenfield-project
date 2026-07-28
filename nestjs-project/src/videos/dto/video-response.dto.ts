import { ApiProperty } from '@nestjs/swagger';
import {
  Video,
  VideoProcessingStatus,
  VideoVisibility,
} from '../entities/video.entity';

/**
 * What `GET /videos/:slug` returns. Explicit `@ApiProperty` everywhere because
 * response DTOs carry no `class-validator` decorators for the Swagger plugin to
 * introspect (per the DTO conventions).
 *
 * This is an allowlist, not a projection of the entity: `channel_id` and
 * `upload_id` are deliberately absent. The first is already implied by the
 * token, and the second is an internal storage handle — echoing it back would
 * let a client keep operating on a multipart the API considers closed.
 */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Short public identifier used in URLs.' })
  slug: string;

  @ApiProperty()
  original_filename: string;

  @ApiProperty({ enum: VideoProcessingStatus })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ enum: VideoVisibility })
  visibility: VideoVisibility;

  // --- Written by the worker; all null until processing finishes ---

  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  audio_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  format_name: string | null;

  @ApiProperty({ type: Number, nullable: true })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true })
  bitrate: number | null;

  /**
   * Why processing failed, when `processing_status` is `failed`. The failure
   * reaches the client through this field rather than an error status — reading
   * a video that failed to process is a successful read.
   */
  @ApiProperty({ type: String, nullable: true })
  failure_reason: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.id,
    slug: video.slug,
    original_filename: video.original_filename,
    processing_status: video.processing_status,
    visibility: video.visibility,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    format_name: video.format_name,
    size_bytes: video.size_bytes,
    bitrate: video.bitrate,
    failure_reason: video.failure_reason,
    created_at: video.created_at.toISOString(),
  };
}
