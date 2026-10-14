import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { DatabaseService } from '../../src/database/database.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChatGateway } from '../../src/realtime/chat.gateway.js';

export async function verifySocketSessions(app: INestApplication, db: DatabaseService): Promise<void> {
  const password = 'socket lifecycle passphrase', suffix = randomUUID();
  const user = await db.user.create({ data: { email: `socket-life-${suffix}@example.test`, displayName: 'Lifecycle', passwordHash: await hashPassword(password) } });
  const sessions = app.get(SessionService), channels = app.get(ChannelsService), server = app.get(ChatGateway).server;
  const endpoint = await app.getUrl(), origin = 'http://127.0.0.1:8080', sockets: Socket[] = [];
  const login = async () => (await sessions.login({ email: user.email, password })).cookie.split(';')[0]!;
  const client = (cookie: string) => {
    const socket = io(endpoint, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'], extraHeaders: { origin, cookie } });
    sockets.push(socket); return socket;
  };
  const connect = async (socket: Socket) => {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  };
  const disconnected = (socket: Socket) => new Promise<string>(resolve => socket.once('disconnect', resolve));
  try {
    const cookie = await login(), otherCookie = await login();
    const first = client(cookie), second = client(cookie), other = client(otherCookie);
    await Promise.all([first, second, other].map(connect));
    const channel = (await channels.create(user.id, { name: `Lifecycle ${suffix}`, slug: `lifecycle-${suffix}` })).channel;
    for (const socket of [first, second, other]) assert.equal((await socket.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id })).ok, true);
    const ended: string[] = []; first.on('session:ended', () => ended.push('first')); second.on('session:ended', () => ended.push('second'));
    const ids = [first.id!, second.id!], closed = [disconnected(first), disconnected(second)];
    const csrf = await (await fetch(`${endpoint}/api/auth/session/csrf`, { headers: { origin, cookie } })).json() as { csrfToken: string };
    const response = await fetch(`${endpoint}/api/auth/logout`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf.csrfToken } });
    assert.equal(response.status, 204);
    assert.deepEqual(await Promise.all(closed), ['io server disconnect', 'io server disconnect']);
    assert.deepEqual(ended.sort(), ['first', 'second']);
    for (const id of ids) assert.equal(server.of('/').sockets.has(id), false);
    assert.equal(other.connected, true); assert.equal((await sessions.me(otherCookie)).user.id, user.id);
    const rejected = new Promise<Error & { data?: { code: string } }>(resolve => first.once('connect_error', resolve));
    first.connect(); assert.equal((await rejected).data?.code, 'UNAUTHENTICATED');

    // Leaving while offline must be checked again by the replacement socket.
    const closedOther = disconnected(other); other.disconnect(); await closedOther;
    await channels.setMembership(user.id, channel.id, false);
    await connect(other);
    const subscription = await other.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id });
    assert.equal(subscription.ok, false); assert.equal(subscription.error.code, 'FORBIDDEN');
    assert.equal(server.of('/').adapter.rooms.get(`channel:${channel.id}`)?.has(other.id!) ?? false, false);

    const shortCookie = await login(), shortSession = await sessions.authenticate(shortCookie);
    await db.session.update({ where: { id: shortSession.id }, data: { expiresAt: new Date(Date.now() + 1200) } });
    const idle = client(shortCookie), idleToo = client(shortCookie);
    await Promise.all([connect(idle), connect(idleToo)]);
    const expired = [disconnected(idle), disconnected(idleToo)];
    assert.deepEqual(await Promise.all(expired), ['io server disconnect', 'io server disconnect']);
    assert.equal(other.connected, true);

    // Hold either handshake authentication or the indexed post-connect check after its DB read.
    for (const heldRead of [1, 2]) {
      const raceCookie = await login(), raceSession = await sessions.authenticate(raceCookie), racing = client(raceCookie);
      let enter!: () => void, release!: () => void, reads = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const authenticate = sessions.authenticate.bind(sessions);
      const held = mock.method(sessions, 'authenticate', async (cookie: string | undefined) => {
        const result = await authenticate(cookie);
        if (cookie === raceCookie && ++reads === heldRead) { enter(); await gate; }
        return result;
      });
      try {
        const closed = disconnected(racing); const connecting = connect(racing);
        await entered; await sessions.revoke(raceSession.id); release();
        await connecting; assert.equal(await closed, 'io server disconnect');
        assert.equal(racing.connected, false); assert.equal(other.connected, true);
      } finally { release(); held.mock.restore(); }
    }
  } finally {
    for (const socket of sockets) socket.disconnect();
    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.channel.deleteMany({ where: { createdBy: user.id } });
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}
