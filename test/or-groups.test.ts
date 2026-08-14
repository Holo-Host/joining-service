import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { createTestApp, fakeAgentKey } from './helpers.js';
import { encodeHashToBase64, agentPubKeyFrom32 } from '../src/utils.js';

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

describe('OR groups (any_of)', () => {
  it('completing one method in an OR group satisfies the group', async () => {
    const { agentKey, privateKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'invite_code'] }],
      allowed_agents: [agentKey],
      invite_codes: ['CODE-1'],
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, claims: { invite_code: 'CODE-1' } }),
    });
    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();

    // Both methods should produce challenges, but with the same group
    // invite_code is auto-verified, so it may already be completed
    // agent_allow_list produces a nonce challenge
    // Since invite_code auto-verifies and is in an OR group, session should be ready
    expect(joinBody.status).toBe('ready');
  });

  it('challenges in OR group share a group id', async () => {
    const { agentKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'email_code'] }],
      allowed_agents: [agentKey],
      email: { provider: 'file', output_dir: '/tmp/test-or-emails' },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'test@example.com' },
      }),
    });
    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();

    // Both agent_allow_list and email_code produce challenges and neither auto-completes
    // so status should be pending
    expect(joinBody.status).toBe('pending');
    expect(joinBody.challenges).toHaveLength(2);

    // Verify both challenges have the same group id
    const groups = joinBody.challenges.map((c: { group?: string }) => c.group);
    expect(groups[0]).toBeDefined();
    expect(groups[1]).toBeDefined();
    expect(groups[0]).toBe(groups[1]);
  });

  it('invalid invite code in OR group returns rejected', async () => {
    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['email_code', 'invite_code'] }],
      email: { provider: 'file', output_dir: '/tmp/test-or-emails' },
      invite_codes: ['VALID-CODE'],
    });

    const agentKey = fakeAgentKey();
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { email: 'test@example.com', invite_code: 'WRONG-CODE' },
      }),
    });

    // Invite codes are auto-verified at join time, so presenting a wrong code
    // is a definitive failure: the join is rejected outright rather than left
    // pending on the group's other alternatives.
    expect(joinRes.status).toBe(403);
    const body = await joinRes.json();
    expect(body.error.code).toBe('join_rejected');
  });

  it('AND + OR combo: standalone AND must also be completed', async () => {
    const { agentKey, privateKey } = await generateAgentKeypair();

    const { request } = await createTestApp({
      auth_methods: [
        'agent_allow_list',
        { any_of: ['invite_code', 'email_code'] },
      ],
      allowed_agents: [agentKey],
      invite_codes: ['COMBO-CODE'],
      email: { provider: 'file', output_dir: '/tmp/test-combo-emails' },
    });

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { invite_code: 'COMBO-CODE' },
      }),
    });
    expect(joinRes.status).toBe(201);
    const joinBody = await joinRes.json();

    // invite_code in the OR group auto-verifies, so the OR group is satisfied.
    // But agent_allow_list (AND) still needs verification.
    expect(joinBody.status).toBe('pending');

    const wlChallenge = joinBody.challenges.find(
      (c: { type: string }) => c.type === 'agent_allow_list',
    );
    expect(wlChallenge).toBeDefined();

    // Sign the nonce
    const nonceBytes = Buffer.from(wlChallenge.metadata.nonce, 'base64');
    const signature = await ed.signAsync(nonceBytes, privateKey);

    const verifyRes = await request(`/v1/join/${joinBody.session}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: wlChallenge.id,
        response: Buffer.from(signature).toString('base64'),
      }),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.status).toBe('ready');
  });

  it('OR group where no method produces challenges is rejected', async () => {
    // agent_allow_list with non-allow-listed key, invite_code with no code claim
    // Both will fail to produce challenges
    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['agent_allow_list'] }],
      allowed_agents: [], // no agents allow-listed
    });

    const agentKey = fakeAgentKey();
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(403);
    const body = await joinRes.json();
    expect(body.error.code).toBe('join_rejected');
    expect(body.error.message).toBe('No eligible auth method in group');
  });

  it('non-allow-listed agent can still join via OR alternative', async () => {
    const agentKey = fakeAgentKey(99);

    const { request } = await createTestApp({
      auth_methods: [{ any_of: ['agent_allow_list', 'invite_code'] }],
      allowed_agents: [], // this agent is not allow-listed
      invite_codes: ['FALLBACK-CODE'],
    });

    // agent_allow_list returns empty (not allow-listed),
    // but invite_code in the same OR group should work
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        claims: { invite_code: 'FALLBACK-CODE' },
      }),
    });
    expect(joinRes.status).toBe(201);
    const body = await joinRes.json();
    // invite_code auto-verifies, so session should be ready
    expect(body.status).toBe('ready');
  });
});
