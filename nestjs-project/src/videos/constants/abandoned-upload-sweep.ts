/**
 * Parameters of the abandoned-multipart sweep (per phase-03-videos/TD-03
 * revision 2).
 *
 * The original decision was a bucket lifecycle rule with
 * `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }`. The MinIO this
 * phase runs does not implement that action, so the mechanism moved into the
 * application — but the threshold below is literally the superseded
 * `DaysAfterInitiation: 1`, carried over rather than re-invented.
 */

/**
 * How old an in-progress multipart must be before the sweep reclaims it.
 *
 * Deliberately generous: a 10 GiB upload over a slow link legitimately stays
 * open for hours, and aborting one mid-flight destroys work the client cannot
 * recover. Storage held for an extra day is the cheaper mistake.
 */
export const ABANDONED_UPLOAD_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How often the sweep runs. Hourly is well below the threshold above, so an
 * upload is reclaimed within an hour of crossing it, and the listing cost is
 * one paginated `ListMultipartUploads` per hour.
 */
export const ABANDONED_UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
