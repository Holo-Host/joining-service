import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { createTestApp, fakeAgentKey } from './helpers.js';
import { encodeHashToBase64, agentPubKeyFrom32 } from '../src/utils.js';
import { AgentAllowListAuthMethod } from '../src/auth-methods/agent-allow-list.js';
import { MemoryAllowedAgentStore } from '../src/agent-registration/index.js';

// Generate a real ed25519 keypair encoded as a valid 39-byte AgentPubKey
async function generateAgentKeypair(): Promise<{
  agentKey: string;
  privateKey: Uint8Array;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    agentKey: encodeHashToBase64(agentPubKeyFrom32(publicKey)),
    privateKey,
  };
}

describe('Agent allow list flow', () => {
  it('allow-listed agent can join by signing nonce', async () => {
    const { agentKey, privateKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [agentKey],
    });

    // Join -- should get a pending challenge with a nonce
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();
    expect(joinBody.status).toBe('pending');
    expect(joinBody.challenges).toHaveLength(1);

    const challenge = joinBody.challenges[0];
    expect(challenge.type).toBe('agent_allow_list');
    expect(challenge.metadata.nonce).toBeDefined();
    // agent_key should be stripped from client-facing metadata
    expect(challenge.metadata.agent_key).toBeUndefined();

    // Sign the nonce with the agent's private key
    const nonceBytes = Buffer.from(challenge.metadata.nonce, 'base64');
    const signature = await ed.signAsync(nonceBytes, privateKey);
    const sigBase64 = Buffer.from(signature).toString('base64');

    // Verify the challenge
    const verifyRes = await request(`/v1/join/${joinBody.session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge.id,
        response: sigBase64,
      }),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.status).toBe('ready');
  });

  it('non-allow-listed agent is rejected (AND context)', async () => {
    const { agentKey } = await generateAgentKeypair();
    const { agentKey: otherKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [otherKey], // only otherKey is allowed
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    const body = await joinRes.json();
    expect(body.status).toBe('rejected');
  });

  it('bad signature fails verification', async () => {
    const { agentKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [agentKey],
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const joinBody = await joinRes.json();
    const challenge = joinBody.challenges[0];

    // Send garbage as signature
    const verifyRes = await request(`/v1/join/${joinBody.session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge.id,
        response: Buffer.from('not-a-valid-signature').toString('base64'),
      }),
    });
    expect(verifyRes.status).toBe(422);
    const body = await verifyRes.json();
    expect(body.error.code).toBe('verification_failed');
  });

  it('provision available after allow list join', async () => {
    const { agentKey, privateKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: ['agent_allow_list'],
      allowed_agents: [agentKey],
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const joinBody = await joinRes.json();
    const challenge = joinBody.challenges[0];

    const nonceBytes = Buffer.from(challenge.metadata.nonce, 'base64');
    const signature = await ed.signAsync(nonceBytes, privateKey);

    await request(`/v1/join/${joinBody.session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge.id,
        response: Buffer.from(signature).toString('base64'),
      }),
    });

    const provRes = await request(`/v1/join/${joinBody.session}/provision`);
    expect(provRes.status).toBe(200);
    const creds = await provRes.json();
    expect(creds.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
  });
});

describe('Agent allow list plugin with store', () => {
  it('agent registered in the store gets a challenge without being in config', async () => {
    const store = new MemoryAllowedAgentStore();
    const key = fakeAgentKey(30);
    await store.put({ agent_key: key, registered_at: '2026-08-13T00:00:00.000Z' });
    const method = new AgentAllowListAuthMethod([], store);
    const challenges = await method.createChallenges(key, {});
    expect(challenges).toHaveLength(1);
    expect(challenges[0].type).toBe('agent_allow_list');
  });

  it('agent in neither config nor store gets no challenge', async () => {
    const method = new AgentAllowListAuthMethod([], new MemoryAllowedAgentStore());
    expect(await method.createChallenges(fakeAgentKey(31), {})).toHaveLength(0);
  });

  it('static config list keeps working alongside a store', async () => {
    const key = fakeAgentKey(32);
    const method = new AgentAllowListAuthMethod([key], new MemoryAllowedAgentStore());
    expect(await method.createChallenges(key, {})).toHaveLength(1);
  });
});
