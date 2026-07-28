/**
 * Injection token for the S3 client that talks to the storage over the Docker
 * network (Compose service name). Every server -> storage call uses this one.
 */
export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';

/**
 * Injection token for the S3 client built with the browser-reachable endpoint.
 * Used ONLY to sign URLs handed to the client — signing with the internal
 * client would produce a URL that resolves nowhere outside the Compose network.
 */
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

/**
 * Default lifetime of a presigned URL, in seconds. The presigner's own default
 * is 900s; every call site passes this explicitly instead, because with
 * redirect-to-presigned-URL delivery the access control IS the time window.
 */
export const PRESIGN_EXPIRES_IN_SECONDS = 300;

/**
 * S3 protocol floor for every part of a multipart upload except the last one.
 */
export const MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;
