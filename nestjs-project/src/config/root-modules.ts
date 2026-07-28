import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';

/**
 * Root wiring shared by every entrypoint — the HTTP app (`AppModule`) and the
 * queue worker (`VideoProcessingModule`). Both processes read the same
 * environment and talk to the same database, so duplicating these two blocks
 * would mean two places to keep in sync; phase 01 already fixed that database
 * parameters come from one factory only.
 */
export const ConfigRootModule = ConfigModule.forRoot({
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    queueConfig,
    storageConfig,
    swaggerConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
});

export const TypeOrmRootModule = TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres' as const,
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
});
