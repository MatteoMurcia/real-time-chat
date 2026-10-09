export const errorCodes = [
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND',
  'CONFLICT', 'RATE_LIMITED', 'INTERNAL_ERROR',
] as const;

export type ErrorCode = typeof errorCodes[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  requestId: string;
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === 'string'
    && errorCodes.some(code => code === error.code)
    && typeof error.message === 'string' && error.message.length > 0
    && typeof error.requestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(error.requestId);
}
