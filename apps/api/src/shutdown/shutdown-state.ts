import { Injectable, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { diagnostic } from '../logging/logger.js';

export class ShutdownError extends ServiceUnavailableException {
  constructor() { super('The service is shutting down. Retry later.'); }
}

@Injectable()
export class ShutdownState {
  readonly requestId = randomUUID();
  draining = false;
  private active = 0;
  private idle: Promise<void> | undefined;
  private resolveIdle: (() => void) | undefined;
  private closing: Promise<void> | undefined;

  get pending(): number { return this.active; }

  enter(): () => void {
    if (this.draining) throw new ShutdownError();
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) this.resolveIdle?.();
    };
  }

  drain(): Promise<void> {
    this.draining = true;
    return this.idle ??= this.active ? new Promise(resolve => { this.resolveIdle = resolve; }) : Promise.resolve();
  }

  close(app: INestApplication): Promise<void> {
    if (!this.closing) {
      const started = performance.now(), idle = this.drain();
      diagnostic({ event: 'shutdown.start', requestId: this.requestId, pendingOperations: this.pending });
      // Nest destroys database providers before transport disposal; drain before either phase.
      this.closing = idle.then(() => app.close()).then(() => {
        diagnostic({ event: 'shutdown.complete', requestId: this.requestId, durationMs: Math.round(performance.now() - started) });
      });
    }
    return this.closing;
  }
}
