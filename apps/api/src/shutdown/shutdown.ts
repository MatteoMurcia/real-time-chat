import type { CallHandler, ExecutionContext, INestApplication, NestInterceptor } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, RequestHandler } from 'express';
import { defer, finalize } from 'rxjs';
import { diagnostic } from '../logging/logger.js';
import { ShutdownError, ShutdownState } from './shutdown-state.js';

export const SHUTDOWN_TIMEOUT_MS = 8000;
const isHealth = (request: Request) => request.method === 'GET'
  && ['/api/health/live', '/api/health/ready'].includes(request.path);

class ShutdownInterceptor implements NestInterceptor {
  constructor(private readonly state: ShutdownState) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    if (this.state.draining && isHealth(context.switchToHttp().getRequest<Request>())) return next.handle();
    return defer(() => {
      const release = this.state.enter();
      return next.handle().pipe(finalize(release));
    });
  }
}

export function configureShutdown(app: NestExpressApplication, state: ShutdownState): void {
  const gate: RequestHandler = (request, _response, next) => next(state.draining && !isHealth(request) ? new ShutdownError() : undefined);
  app.use(gate);
  app.useGlobalInterceptors(new ShutdownInterceptor(state));
}

export function installShutdownHandlers(app: INestApplication): void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const state = app.get(ShutdownState);
    const deadline = setTimeout(() => {
      diagnostic({ event: 'shutdown.timeout', requestId: state.requestId, code: 'INTERNAL_ERROR', pendingOperations: state.pending });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    void state.close(app).then(() => {
      // Do not keep a clean process alive; still bound an unexpected remaining referenced handle.
      deadline.unref();
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
    }, () => {
      diagnostic({ event: 'shutdown.failure', requestId: state.requestId, code: 'INTERNAL_ERROR', pendingOperations: state.pending });
      process.exitCode = 1; // Keep the deadline until process exit if resource disposal failed.
    });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
