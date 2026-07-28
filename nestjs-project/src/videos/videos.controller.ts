import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import type { HttpRedirectResponse } from '@nestjs/common';
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
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto, toVideoResponse } from './dto/video-response.dto';
import {
  VideosService,
  type CompleteUploadResult,
  type InitiateUploadResult,
} from './videos.service';

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
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the authenticated user has no channel to own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    // The owning channel always comes from the token. A `channel_id` in the
    // body is ignored by construction — the DTO does not declare it, and the
    // global ValidationPipe strips unknown properties.
    return this.videosService.initiateUpload(
      await this.ownChannelId(user),
      dto,
    );
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload with the ETags the client collected, moves ' +
      'the video to `processing` and enqueues the processing job. Answers 202 ' +
      'because the work continues in the background.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        processing_status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or :id is not a uuid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the id does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_UPLOAD_STATE or INVALID_UPLOAD_PARTS',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    // Ownership is resolved before any effect: the service scopes its lookup by
    // channel, so a video of another channel is indistinguishable from one that
    // does not exist — 404 either way, never 403.
    return this.videosService.completeUpload(
      await this.ownChannelId(user),
      id,
      dto,
    );
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Read your own video',
    description:
      'Returns the state and metadata of a video owned by the caller. This is ' +
      'the observable counterpart of the 202 returned by the completion call: ' +
      'polling it is how a client learns that processing finished. The ' +
      'metadata fields are null until the worker writes them, and a permanent ' +
      'failure surfaces as `failure_reason`, not as an error status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the slug does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnBySlug(
      await this.ownChannelId(user),
      slug,
    );

    return toVideoResponse(video);
  }

  @Get(':slug/stream')
  @Redirect('', HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Stream your own video',
    description:
      'Redirects to a short-lived presigned GET URL for the video object. The ' +
      'API never proxies bytes, which is what leaves `Range`/206 handling to ' +
      'the object storage.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Location carries the presigned URL, signed with the storage public endpoint',
    headers: {
      Location: {
        description:
          'Presigned GET URL for the video object; expires in minutes',
        schema: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the slug does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY or VIDEO_PROCESSING_FAILED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.buildStreamUrl(
      await this.ownChannelId(user),
      slug,
    );

    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':slug/download')
  @Redirect('', HttpStatus.FOUND)
  @ApiOperation({
    summary: 'Download your own video',
    description:
      'Same mechanism as streaming, except the presigned URL carries a ' +
      '`Content-Disposition: attachment` override so the storage serves the ' +
      'object as a file named after the original upload.',
  })
  @ApiResponse({
    status: 302,
    description:
      'Location carries the presigned URL with the attachment override',
    headers: {
      Location: {
        description:
          'Presigned GET URL carrying a Content-Disposition attachment override',
        schema: { type: 'string', format: 'uri' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — the slug does not exist or belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY or VIDEO_PROCESSING_FAILED',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<HttpRedirectResponse> {
    const url = await this.videosService.buildDownloadUrl(
      await this.ownChannelId(user),
      slug,
    );

    return { url, statusCode: HttpStatus.FOUND };
  }

  /**
   * The caller's owning channel, resolved from the token and never from the
   * request payload. A user without a channel gets the same 404 as a stranger
   * asking for someone else's video — there is nothing of theirs to address.
   */
  private async ownChannelId(user: JwtPayload): Promise<string> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    return channel.id;
  }
}
