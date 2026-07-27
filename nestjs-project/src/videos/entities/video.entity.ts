import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Where the video is in the upload/processing pipeline. Orthogonal to
 * `VideoVisibility` — a video can be `ready` and still `draft`.
 */
export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

/**
 * Whether the video is published. This phase only ever occupies `draft` — the
 * publication transition belongs to Phase 04. `published` is declared here
 * because delivery gates on it in later phases; `unlisted` is Phase 04's.
 */
export enum VideoVisibility {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}

/**
 * Postgres `bigint` maps to `string` in the driver, which would leak into every
 * consumer of the size columns. Both values are byte counts capped at 10 GiB
 * (~1.07e10), far below `Number.MAX_SAFE_INTEGER` (~9.0e15), so converting to
 * `number` at the boundary is lossless.
 */
const bigintToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  /** Short random public identifier — decoupled from the PK on purpose. */
  @Column({ type: 'varchar', length: 16, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  /** Declared by the client at initiation; validated against the allowlist. */
  @Column({ type: 'varchar', length: 100 })
  declared_mime: string;

  /** Declared at initiation; validated against the 10 GiB ceiling. */
  @Column({ type: 'bigint', transformer: bigintToNumber })
  declared_size_bytes: number;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @Column({
    type: 'enum',
    enum: VideoVisibility,
    default: VideoVisibility.DRAFT,
  })
  visibility: VideoVisibility;

  /** The storage multipart `UploadId`; cleared on completion or abort. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  // --- Written by the worker after ffprobe; all null until processing ends ---

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  /**
   * `ffprobe` container name. Also carries the container that the object key no
   * longer encodes — the key is `{id}/source`, without extension.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  format_name: string | null;

  /** Real size observed after upload, compared against `declared_size_bytes`. */
  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  size_bytes: number | null;

  @Column({ type: 'integer', nullable: true })
  bitrate: number | null;

  /** Which permanent-failure condition fired, when `processing_status` is `failed`. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
