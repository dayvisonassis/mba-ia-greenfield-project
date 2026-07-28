import { execFile } from 'child_process';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

/**
 * Where in the video the thumbnail frame is taken from. One second in avoids
 * the black or blank first frame most encoders produce, and is clamped below
 * so it never lands past the end of a short clip.
 */
const THUMBNAIL_SECONDS = 1;

/** Width of the generated thumbnail; height follows the source aspect ratio. */
const THUMBNAIL_WIDTH = 640;

@Injectable()
export class FfmpegAdapter {
  /**
   * Cuts a single frame to a JPEG on local disk.
   *
   * Same rule as the probe adapter: `execFile` with an argument ARRAY, never
   * `exec` with an interpolated string (per phase-03-videos/TD-05).
   */
  async extractThumbnail(
    inputPath: string,
    outputPath: string,
    durationSeconds: number | null,
  ): Promise<void> {
    // A 0.5s clip has no frame at 1s; seeking past the end yields no output
    // file and the failure would surface later, as a confusing upload error.
    const seek =
      durationSeconds !== null && durationSeconds < THUMBNAIL_SECONDS * 2
        ? Math.max(durationSeconds / 2, 0)
        : THUMBNAIL_SECONDS;

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      seek.toFixed(3),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      '-f',
      'image2',
      outputPath,
    ]);
  }
}
