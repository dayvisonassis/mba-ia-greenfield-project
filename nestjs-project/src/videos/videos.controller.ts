import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelsService } from '../channels/channels.service';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService, type InitiateUploadResult } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  // No @Public() anywhere in this controller: every video route is owner-only
  // in this phase, and the global JwtAuthGuard is what enforces it.
  @Post()
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Validates the client declaration, creates the video as a draft, opens a ' +
      'multipart upload in object storage and returns one presigned URL per ' +
      'part. No byte of the file passes through the API — the client PUTs each ' +
      'part straight at the returned URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        upload_id: { type: 'string' },
        part_size_bytes: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, UNSUPPORTED_VIDEO_FORMAT or VIDEO_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    // The owning channel always comes from the token. A `channel_id` in the
    // body is ignored by construction — the DTO does not declare it, and the
    // global ValidationPipe strips unknown properties.
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    return this.videosService.initiateUpload(channel.id, dto);
  }
}
