import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

/** The slice of `ffprobe -print_format json` output this phase consumes. */
interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}

/** Normalized metadata, shaped like the columns it lands in. */
export interface VideoMetadata {
  format_name: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  size_bytes: number | null;
  bitrate: number | null;
  hasVideoStream: boolean;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

@Injectable()
export class FfprobeAdapter {
  /**
   * Reads container and stream metadata from a local file.
   *
   * `execFile` with an argument ARRAY, never `exec` with an interpolated
   * string: a shell is never spawned, so no argument can be read as a command
   * separator (per phase-03-videos/TD-05). The path passed here is derived from
   * the video id, so the client-supplied filename never reaches a command line
   * at all — defence in depth rather than a single check.
   */
  async probe(filePath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    return {
      format_name: parsed.format?.format_name ?? '',
      duration_seconds: toInt(parsed.format?.duration),
      width: video?.width ?? null,
      height: video?.height ?? null,
      video_codec: video?.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
      size_bytes: toInt(parsed.format?.size),
      bitrate: toInt(parsed.format?.bit_rate),
      // An mp4 carrying only an audio track is a legitimate file with an
      // accepted container — and still not a video. TD-09 makes this its own
      // rejection condition.
      hasVideoStream: video !== undefined,
    };
  }
}
