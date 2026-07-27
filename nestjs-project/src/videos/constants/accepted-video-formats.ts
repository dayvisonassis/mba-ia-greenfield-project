/**
 * Single source of truth for what the platform accepts, imported by BOTH the
 * API (declaration check at upload initiation) and the worker (authoritative
 * `ffprobe` check after upload). They share one codebase precisely so this
 * cannot drift into two lists that disagree (per phase-03-videos/TD-09).
 */

/**
 * MP4 and WebM are the two containers browsers play natively. This phase serves
 * the original file and does not transcode, so accepting anything else would
 * make "streaming works" true for only part of the uploads. Widening this list
 * belongs to whichever phase introduces transcoding.
 */
export const ACCEPTED_VIDEO_MIMES = ['video/mp4', 'video/webm'] as const;

export type AcceptedVideoMime = (typeof ACCEPTED_VIDEO_MIMES)[number];

/**
 * `ffprobe` reports the container in `format_name`, and its names do not match
 * MIME types one-to-one: MP4 arrives inside the `mov,mp4,m4a,3gp,3g2,mj2`
 * family string, WebM as `matroska,webm`. The worker matches against these.
 */
export const ACCEPTED_FORMAT_NAMES = ['mp4', 'webm'] as const;

/** 10 GiB — the ceiling the challenge fixes for a single upload. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export function isAcceptedVideoMime(mime: string): mime is AcceptedVideoMime {
  return (ACCEPTED_VIDEO_MIMES as readonly string[]).includes(mime);
}

/**
 * `ffprobe`'s `format_name` is a comma-separated family list, so an exact
 * comparison would reject valid MP4 files. Matching any member against the
 * accepted names is what makes the worker's check agree with the API's.
 */
export function isAcceptedFormatName(formatName: string): boolean {
  const reported = formatName.split(',').map((name) => name.trim());
  return reported.some((name) =>
    (ACCEPTED_FORMAT_NAMES as readonly string[]).includes(name),
  );
}
