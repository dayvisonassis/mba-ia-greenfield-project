import { registerAs } from '@nestjs/config';

/**
 * Object storage (MinIO / S3-compatible).
 *
 * `internalEndpoint` and `publicEndpoint` are deliberately separate values.
 * The internal one is the Compose service name and only resolves inside the
 * Docker network — it is what the API uses to talk to the storage. The public
 * one is what a browser can reach, and is used ONLY to sign URLs that are
 * handed to the client. Signing with the internal endpoint would produce a URL
 * nobody outside the network can open.
 *
 * Every key below is `required()` in `env.validation.ts`, so the non-null
 * assertions hold: the app cannot boot with any of them missing.
 */
export default registerAs('storage', () => ({
  internalEndpoint: process.env.STORAGE_ENDPOINT_INTERNAL!,
  publicEndpoint: process.env.STORAGE_ENDPOINT_PUBLIC!,
  region: process.env.STORAGE_REGION!,
  accessKeyId: process.env.STORAGE_ACCESS_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  videosBucket: process.env.STORAGE_BUCKET_VIDEOS!,
  thumbnailsBucket: process.env.STORAGE_BUCKET_THUMBNAILS!,
}));
