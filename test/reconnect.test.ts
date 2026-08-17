import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { decode, encode } from '@msgpack/msgpack';
import { createTestApp, fakeDnaHash } from './helpers.js';
import { encodeHashToBase64, agentPubKeyFrom32 } from '../src/utils.js';

// Build a proper 39-byte AgentPubKey from a real ed25519 public key
function buildAgentKey(publicKey: Uint8Array): string {
  return encodeHashToBase64(agentPubKeyFrom32(publicKey));
}

/** Sign the current timestamp the same way a real client would for /v1/reconnect. */
async function signTimestamp(
  privateKey: Uint8Array,
): Promise<{ timestamp: string; signature: string }> {
  const timestamp = new Date().toISOString();
  const msgBytes = new TextEncoder().encode(timestamp);
  const signature = await ed.signAsync(msgBytes, privateKey);
  return { timestamp, signature: Buffer.from(signature).toString('base64') };
}

/** POST /v1/reconnect with a freshly signed timestamp, optionally scoped to a network. */
async function postReconnect(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  agentKey: string,
  privateKey: Uint8Array,
  network?: string,
): Promise<Response> {
  const { timestamp, signature } = await signTimestamp(privateKey);
  const body: Record<string, unknown> = { agent_key: agentKey, timestamp, signature };
  if (network !== undefined) body.network = network;
  return request('/v1/reconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Reconnect flow', () => {
  it('reconnect with valid signature returns updated URLs and the static session token', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
    });

    // Generate a real ed25519 key pair
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // First, join to register the agent
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    const { session: joinedSessionId } = await joinRes.json();

    const reconnRes = await postReconnect(request, agentKey, privateKey);

    expect(reconnRes.status).toBe(200);
    const body = await reconnRes.json();
    expect(body.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
    expect(body.session).toBe(joinedSessionId);
  });

  it('reconnect with network explicitly set to the static happ id returns the same session as an omitted network', async () => {
    const { request, ctx } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    const { session: joinedSessionId } = await joinRes.json();

    // Naming the static network explicitly must land in exactly the same
    // scope as omitting `network` -- the brief singles this equivalence out.
    const reconnRes = await postReconnect(request, agentKey, privateKey, ctx.config.happ.id);

    expect(reconnRes.status).toBe(200);
    const body = await reconnRes.json();
    expect(body.session).toBe(joinedSessionId);
  });

  it('reconnect rejects a non-string network with 400 rather than silently falling back to the static session', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // Agent has a ready static-scope session -- a buggy fallback would
    // return its token here even though the caller asked about a different
    // (malformed) network, which is worse than an error.
    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    const { timestamp, signature } = await signTimestamp(privateKey);
    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, timestamp, signature, network: 12345 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_network');
    expect(body.session).toBeUndefined();
  });

  it('reconnect rejects a null network with 400', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    const { timestamp, signature } = await signTimestamp(privateKey);
    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, timestamp, signature, network: null }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('unknown_network');
    expect(body.session).toBeUndefined();
  });

  it('reconnect with invalid signature returns 400 and no session token', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // Join first
    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    const timestamp = new Date().toISOString();
    // Sign with a DIFFERENT key
    const wrongKey = ed.utils.randomPrivateKey();
    const wrongSig = await ed.signAsync(
      new TextEncoder().encode(timestamp),
      wrongKey,
    );

    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        timestamp,
        signature: Buffer.from(wrongSig).toString('base64'),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_signature');
    // The security property the whole design rests on: a ready session
    // exists for this agent, but an unverified caller must not learn its id.
    expect(body.session).toBeUndefined();
  });

  it('reconnect for unknown agent returns 403', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    const timestamp = new Date().toISOString();
    const sig = await ed.signAsync(
      new TextEncoder().encode(timestamp),
      privateKey,
    );

    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        timestamp,
        signature: Buffer.from(sig).toString('base64'),
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('agent_not_joined');
  });

  it('reconnect with stale timestamp returns 400', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // Join first
    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });

    // Timestamp 10 minutes ago (beyond 5 min tolerance)
    const staleTs = new Date(Date.now() - 600_000).toISOString();
    const sig = await ed.signAsync(
      new TextEncoder().encode(staleTs),
      privateKey,
    );

    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: agentKey,
        timestamp: staleTs,
        signature: Buffer.from(sig).toString('base64'),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('timestamp_out_of_range');
  });

  it('reconnect with omitted network and only a non-static session returns URLs but no session token', async () => {
    const adminSecret = 'net-admin-secret';
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
      network_registration: { admin_secret: adminSecret },
    });

    const registerRes = await request('/v1/admin/networks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({
        happ_id: 'network-a',
        roles: { role_a: {} },
      }),
    });
    expect(registerRes.status).toBe(201);

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // The agent's only session names a network -- findAnyByAgentKey must
    // still find it, since reconnect's URLs are service-wide, not per-network.
    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });
    expect(joinRes.status).toBe(201);
    expect((await joinRes.json()).status).toBe('ready');

    const reconnRes = await postReconnect(request, agentKey, privateKey);

    expect(reconnRes.status).toBe(200);
    const body = await reconnRes.json();
    expect(body.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090' }]);
    // Omitted `network` targets the static scope, which this agent has no
    // session in -- that's not an error, just no session to hand back.
    expect(body.session).toBeUndefined();
  });

  it('reconnect with an explicit network returns that network\'s token, not the static one\'s', async () => {
    const adminSecret = 'net-admin-secret';
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
      network_registration: { admin_secret: adminSecret },
    });

    await request('/v1/admin/networks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({ happ_id: 'network-a', roles: { role_a: {} } }),
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    const staticJoinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    const { session: staticSessionId } = await staticJoinRes.json();

    const networkJoinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });
    const { session: networkSessionId } = await networkJoinRes.json();
    expect(networkSessionId).not.toBe(staticSessionId);

    const reconnRes = await postReconnect(request, agentKey, privateKey, 'network-a');

    expect(reconnRes.status).toBe(200);
    const body = await reconnRes.json();
    expect(body.session).toBe(networkSessionId);
    expect(body.session).not.toBe(staticSessionId);
  });

  it('an agent with sessions on two networks gets the right token for each', async () => {
    const adminSecret = 'net-admin-secret';
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
      network_registration: { admin_secret: adminSecret },
    });

    for (const happId of ['network-a', 'network-b']) {
      const res = await request('/v1/admin/networks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({ happ_id: happId, roles: { role_a: {} } }),
      });
      expect(res.status).toBe(201);
    }

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    const joinA = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });
    const { session: sessionA } = await joinA.json();

    const joinB = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-b' }),
    });
    const { session: sessionB } = await joinB.json();

    expect(sessionA).not.toBe(sessionB);

    const reconnA = await postReconnect(request, agentKey, privateKey, 'network-a');
    expect((await reconnA.json()).session).toBe(sessionA);

    const reconnB = await postReconnect(request, agentKey, privateKey, 'network-b');
    expect((await reconnB.json()).session).toBe(sessionB);
  });

  it('reconnect with an explicit network and no ready session there returns 403 naming the network', async () => {
    const adminSecret = 'net-admin-secret';
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
      network_registration: { admin_secret: adminSecret },
    });

    for (const happId of ['network-a', 'network-b']) {
      await request('/v1/admin/networks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({ happ_id: happId, roles: { role_a: {} } }),
      });
    }

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    // Agent has joined network-a, but never network-b.
    await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey, network: 'network-a' }),
    });

    const res = await postReconnect(request, agentKey, privateKey, 'network-b');

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('agent_not_joined');
    expect(body.error.message).toContain('network-b');
  });

  it('reconnect when disabled returns 404', async () => {
    const { request } = await createTestApp({
      reconnect: { enabled: false },
    });

    const res = await request('/v1/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_key: 'test',
        timestamp: new Date().toISOString(),
        signature: 'test',
      }),
    });

    expect(res.status).toBe(404);
  });

  it('end-to-end recovery: join, discard the token, reconnect, provision, and get a valid membrane proof', async () => {
    const dnaHash = fakeDnaHash(11);
    const { request } = await createTestApp({
      reconnect: { enabled: true, timestamp_tolerance_seconds: 300 },
      membrane_proof: { enabled: true },
      roles: { main: { dna_hash: dnaHash } },
    });

    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const agentKey = buildAgentKey(publicKey);

    const joinRes = await request('/v1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_key: agentKey }),
    });
    expect(joinRes.status).toBe(201);
    expect((await joinRes.json()).status).toBe('ready');
    // The client crashes here, before ever reading the session token above.

    const reconnRes = await postReconnect(request, agentKey, privateKey);
    expect(reconnRes.status).toBe(200);
    const { session: recoveredSessionId } = await reconnRes.json();
    expect(typeof recoveredSessionId).toBe('string');

    const provRes = await request(`/v1/join/${recoveredSessionId}/provision`);
    expect(provRes.status).toBe(200);
    const provision = await provRes.json();

    const proofB64 = provision.roles.main.membrane_proof as string;
    expect(typeof proofB64).toBe('string');

    // Verify the recovered proof is a genuine, correctly signed envelope --
    // not just that a string came back.
    const proofBytes = Buffer.from(proofB64, 'base64');
    const envelope = decode(proofBytes) as Record<string, unknown>;
    const sig = envelope.signature as Uint8Array;
    const signer = envelope.signer as Uint8Array;
    const data = envelope.data as Record<string, unknown>;
    const dataBytes = encode(data);
    const ed25519Key = signer.slice(3, 35);
    const valid = await ed.verifyAsync(sig, dataBytes, ed25519Key);
    expect(valid).toBe(true);
  });
});
