import { mock } from 'node:test';
import type { Server } from 'socket.io';
import type { PublicMessage } from '@real-time-chat/contracts/messages';

// Patch only existing test sockets and one message key; never load this in the application.
export function suppressMessageEmission(server: Server, clientMessageId: string) {
  const suppressed: PublicMessage[] = [];
  const replacements = [...server.of('/').sockets.values()].map(socket => {
    const original = socket.emit;
    return mock.method(socket, 'emit', (event: string, ...args: unknown[]) => {
      const message = args[0];
      if (event === 'message:created' && message && typeof message === 'object'
        && 'clientMessageId' in message && message.clientMessageId === clientMessageId) {
        suppressed.push(message as PublicMessage); return true;
      }
      return Reflect.apply(original, socket, [event, ...args]) as boolean;
    });
  });
  return { suppressed, restore: () => { for (const replacement of replacements) replacement.mock.restore(); } };
}
