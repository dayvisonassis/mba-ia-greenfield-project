import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigRootModule, TypeOrmRootModule } from './config/root-modules';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [ConfigRootModule, TypeOrmRootModule, AuthModule, VideosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
