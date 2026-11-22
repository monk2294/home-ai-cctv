export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOO_MANY_LOGIN_ATTEMPTS'
  | 'CAMERA_NOT_FOUND'
  | 'PRESET_NOT_FOUND'
  | 'CAMERA_DISABLED'
  | 'CAMERA_UNAVAILABLE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'CAMERA_LIMIT_REACHED'
  | 'DUPLICATE_CAMERA_NAME'
  | 'AI_STREAM_LIMIT_REACHED'
  | 'CAMERA_MEDIA_UNAVAILABLE'
  | 'MEDIA_GATEWAY_UNAVAILABLE'
  | 'MEDIA_UPSTREAM_ERROR'
  | 'MEDIA_TIMEOUT'
  | 'ONVIF_UPSTREAM_ERROR'
  | 'ONVIF_TIMEOUT'
  | 'INVALID_PROFILE'
  | 'INTERNAL_ERROR';

/** Единая обёртка ошибок API (OpenAPI components.schemas.Error). */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  request_id: string;
  details?: Record<string, unknown>;
}

export function errorBody(error: ApiError, requestId: string): ErrorBody {
  const body: ErrorBody = { code: error.code, message: error.message, request_id: requestId };
  if (error.details !== undefined) {
    body.details = error.details;
  }
  return body;
}
