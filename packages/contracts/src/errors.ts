import type { FieldErrors } from './auth.js';

export const errorCodes = [
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND',
  'CONFLICT', 'RATE_LIMITED', 'INTERNAL_ERROR',
] as const;

export type ErrorCode = typeof errorCodes[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: FieldErrors;
}

export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Record<string, unknown>;
  if (error.fieldErrors !== undefined) {
    if (error.code !== 'VALIDATION_ERROR' || !error.fieldErrors || typeof error.fieldErrors !== 'object'
      || Array.isArray(error.fieldErrors)
      || !Object.entries(error.fieldErrors).every(([field, message]) =>
        ['email', 'password', 'displayName'].includes(field)
        && typeof message === 'string' && message.length > 0 && message.length <= 200)) return false;
  }
  return typeof error.code === 'string'
    && errorCodes.some(code => code === error.code)
    && typeof error.message === 'string' && error.message.length > 0
    && typeof error.requestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(error.requestId);
}
