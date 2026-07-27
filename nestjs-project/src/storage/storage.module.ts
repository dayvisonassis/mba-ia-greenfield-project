import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

/**
 * `forcePathStyle` is mandatory against MinIO: without it the SDK builds a
 * virtual-hosted URL (`bucket.minio:9000`) that does not resolve on the Compose
 * network.
 */
const buildClient = (
  endpoint: string,
  config: ConfigType<typeof storageConfig>,
): S3Client =>
  new S3Client({
    endpoint,
    forcePathStyle: true,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config.internalEndpoint, config),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config.publicEndpoint, config),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
