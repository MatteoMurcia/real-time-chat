import { validateRegistration } from '../src/identity/registration.service.js';
import { hashPassword, verifyPassword } from '../src/identity/password.js';
import { ChannelAccessService } from '../src/channels/channel-access.service.js';
import type { DatabaseService } from '../src/database/database.service.js';

export function demoAccounts(env: NodeJS.ProcessEnv) {
  try {
    return ['alice', 'bob'].map((name, index) => ({
      id: `d3e00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ...validateRegistration({ email: `${name}@demo.example.test`, displayName: index ? 'Bob Chen' : 'Alice Rivera',
        password: env[index ? 'DEMO_BOB_PASSWORD' : 'DEMO_ALICE_PASSWORD'] }),
    }));
  } catch { throw new Error('Set valid DEMO_ALICE_PASSWORD and DEMO_BOB_PASSWORD (15–128 characters).'); }
}

export async function seedDemo(db: DatabaseService, env: NodeJS.ProcessEnv): Promise<void> {
  const accounts = demoAccounts(env), access = new ChannelAccessService(db);
  await db.$transaction(async tx => {
    // Serialize seed runs; ordinary sends still coordinate through the canonical channel lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(52710)`;
    for (const account of accounts) {
      const existing = await tx.user.findUnique({ where: { id: account.id } });
      if (existing) {
        if (existing.email !== account.email || !await verifyPassword(account.password, existing.passwordHash)) throw new Error('Demo identity collision or changed credentials');
      } else {
        const { password, ...user } = account;
        await tx.user.create({ data: { ...user, passwordHash: await hashPassword(password) } });
      }
    }
    const topics = ['Welcome to the team! How is your morning going?', 'The prototype is ready for a quick review.',
      'I tried the new flow. The conversation feels clear.', 'Thanks! Let us compare notes after lunch.',
      'Good progress today. See you at the next team check-in.'];
    for (const [index, name] of ['Demo Lounge', 'Demo Planning'].entries()) {
      const id = `d3e10000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const slug = name.toLowerCase().replaceAll(' ', '-'), nameKey = name.toLowerCase(), createdBy = accounts[0]!.id;
      const channel = await tx.channel.upsert({ where: { id }, create: { id, name, slug, nameKey, createdBy }, update: {} });
      if (channel.slug !== slug || channel.nameKey !== nameKey || channel.createdBy !== createdBy) throw new Error('Demo channel collision');
      await access.lockChannel(tx, id);
      for (const account of accounts) await tx.membership.upsert({ where: { userId_channelId: { userId: account.id, channelId: id } },
        create: { userId: account.id, channelId: id }, update: {} });
      for (let position = 1; position <= (index ? 6 : 105); position++) {
        const authorId = accounts[(position - 1) % 2]!.id;
        const clientMessageId = `d3e20000-0000-4000-8000-${String(index * 1000 + position).padStart(12, '0')}`;
        const body = `[Demo ${position}] ${topics[(position - 1) % topics.length]}`;
        const existing = await tx.message.findUnique({ where: { authorId_clientMessageId: { authorId, clientMessageId } } });
        if (existing) {
          if (existing.channelId !== id || existing.body !== body) throw new Error('Demo message collision');
          continue;
        }
        const { lastSequence } = await tx.channel.update({ where: { id }, data: { lastSequence: { increment: 1 } }, select: { lastSequence: true } });
        await tx.message.create({ data: { authorId, clientMessageId, channelId: id, sequence: lastSequence, body,
          createdAt: new Date(Date.UTC(2026, 0, 1, 9 + index, position)) } });
      }
    }
  }, { timeout: 30000 });
}
