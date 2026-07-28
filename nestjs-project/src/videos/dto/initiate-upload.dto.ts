import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ACCEPTED_VIDEO_MIMES,
  MAX_VIDEO_SIZE_BYTES,
} from '../constants/accepted-video-formats';

/**
 * No manual `@ApiProperty` — the Swagger CLI plugin infers the schema from the
 * class-validator decorators (per openapi-docs-nestjs/TD-01).
 */
export class InitiateUploadDto {
  /**
   * Display title. Optional: the capability in scope is the *automatic*
   * pre-registration of the draft, so a client that only has a file can still
   * start an upload — the title is then derived from the filename.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  original_filename: string;

  /**
   * The allowlist check lives here AND in the service. This one produces a 400
   * validation error for a malformed request; the service's produces the
   * domain code `UNSUPPORTED_VIDEO_FORMAT`. Keeping both means the contract is
   * documented in OpenAPI and the rule still holds for any non-HTTP caller.
   */
  @IsString()
  @IsIn(ACCEPTED_VIDEO_MIMES)
  declared_mime: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  declared_size_bytes: number;
}
