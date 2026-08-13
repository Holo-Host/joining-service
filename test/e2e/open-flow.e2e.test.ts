import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { JoiningClient, JoiningError } from '../../src/client/index.js';
import { startE2EServer, fakeAgentKey, type E2EServer } from './helpers.js';
import { fakeDnaHash } from '../helpers.js';

const testDnaHash = fakeDnaHash(1);

describe('E2E: Open auth flow', () => {
  let server: E2EServer;
  let client: JoiningClient;

  beforeAll(async () => {
    server = await startE2EServer({
      auth_methods: ['open'],
      membrane_proof: { enabled: true },
      roles: { app_role: { dna_hash: testDnaHash } },
    });
    client = JoiningClient.fromUrl(`${server.baseUrl}/v1`);
  });

  afterAll(async () => {
    await server.close();
  });

  it('getInfo returns service metadata', async () => {
    const info = await client.getInfo();
    expect(info.happ.id).toBe('e2e-test-app');
    expect(info.auth_methods).toEqual(['open']);
  });

  it('join with open auth returns ready immediately', async () => {
    const agentKey = fakeAgentKey(1);
    const session = await client.join(agentKey);

    expect(session.status).toBe('ready');
    expect(session.sessionToken).toBeTruthy();
    expect(session.challenges).toBeUndefined();
  });

  it('getProvision returns linker URLs and membrane proofs', async () => {
    const agentKey = fakeAgentKey(2);
    const session = await client.join(agentKey);
    expect(session.status).toBe('ready');

    const provision = await session.getProvision();
    expect(provision.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
    expect(provision.roles?.app_role.membrane_proof).toBeTruthy();
  });

  it('rejects duplicate agent key with 409', async () => {
    const agentKey = fakeAgentKey(3);
    await client.join(agentKey);

    try {
      await client.join(agentKey);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JoiningError);
      expect((e as JoiningError).code).toBe('agent_already_joined');
      expect((e as JoiningError).httpStatus).toBe(409);
    }
  });

  it('rejects invalid agent key', async () => {
    try {
      await client.join('not-a-valid-key');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JoiningError);
      expect((e as JoiningError).code).toBe('invalid_agent_key');
      expect((e as JoiningError).httpStatus).toBe(400);
    }
  });
});
