import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { diagnostic } from './logger.js';

export const httpDiagnostics: RequestHandler = (request, response, next) => {
  const started = performance.now(), requestId = randomUUID();
  response.setHeader('X-Request-Id', requestId);
  response.once('finish', () => {
    diagnostic({
      event: 'http.request', requestId,
      method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'].includes(request.method) ? request.method : 'OTHER',
      // Express's registered route template is static; raw URLs and parameters are private.
      route: typeof request.route?.path === 'string' ? request.route.path : 'unmatched',
      status: response.statusCode, code: response.locals.diagnosticCode,
      durationMs: Math.round(performance.now() - started),
    });
  });
  next();
};
