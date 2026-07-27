export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

// --- Videos (phase 03) ---

export class UnsupportedVideoFormatException extends DomainException {
  constructor(declaredMime: string) {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      400,
      `Unsupported video format: ${declaredMime}`,
    );
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 400, 'Video exceeds the maximum allowed size');
  }
}

/**
 * Deliberately the same response for "no such video" and "not yours" — a 403
 * would confirm the resource exists and let a caller enumerate other channels'
 * slugs (per phase-03-videos/TD-07 revision).
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidUploadStateException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_STATE',
      409,
      'Upload cannot be completed from the current processing status',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      409,
      'Storage rejected the reported parts — a part is missing or its ETag does not match',
    );
  }
}
