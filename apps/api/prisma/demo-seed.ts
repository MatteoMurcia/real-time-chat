import { validateRegistration } from '../src/identity/registration.service.js';

export function demoAccounts(env: NodeJS.ProcessEnv) {
  try {
    return ['alice', 'bob'].map((name, index) => ({
      id: `d3e00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      ...validateRegistration({ email: `${name}@demo.example.test`, displayName: index ? 'Bob Chen' : 'Alice Rivera',
        password: env[index ? 'DEMO_BOB_PASSWORD' : 'DEMO_ALICE_PASSWORD'] }),
    }));
  } catch { throw new Error('Set valid DEMO_ALICE_PASSWORD and DEMO_BOB_PASSWORD (15–128 characters).'); }
}
