import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  canonicalJson,
  verifyHeartbeatSignature,
  validateTimestamp,
} from '../../src/linker-registration/verify.js';

describe('canonicalJson', () => {
  it('sorts keys alphabetically', () => {
    const result = canonicalJson({ z: '1', a: '2', m: '3' });
    expect(result).toBe('{"a":"2","m":"3","z":"1"}');
  });

  it('produces no whitespace', () => {
    const result = canonicalJson({ foo: 'bar', baz: 'qux' });
    expect(result).not.toMatch(/\s/);
  });

  it('handles empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('handles single key', () => {
    expect(canonicalJson({ key: 'value' })).toBe('{"key":"value"}');
  });
});

describe('verifyHeartbeatSignature', () => {
  it('accepts a valid signature', async () => {
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = await ed.getPublicKeyAsync(privKey);
    const pubkeyB64 = Buffer.from(pubKey).toString('base64');

    const fields = { admin_url: 'https://example.com', linker_url: 'wss://example.com', pubkey: pubkeyB64, timestamp: '2026-04-01T00:00:00.000Z' };
    const message = new TextEncoder().encode(canonicalJson(fields));
    const sig = await ed.signAsync(message, privKey);
    const sigB64 = Buffer.from(sig).toString('base64');

    const valid = await verifyHeartbeatSignature({
      pubkey: pubkeyB64,
      signature: sigB64,
      fields,
    });
    expect(valid).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = await ed.getPublicKeyAsync(privKey);
    const pubkeyB64 = Buffer.from(pubKey).toString('base64');

    const fields = { pubkey: pubkeyB64, timestamp: '2026-04-01T00:00:00.000Z' };
    const message = new TextEncoder().encode(canonicalJson(fields));
    const sig = await ed.signAsync(message, privKey);
    const sigBytes = new Uint8Array(sig);
    sigBytes[0] ^= 0xff; // flip bits
    const sigB64 = Buffer.from(sigBytes).toString('base64');

    const valid = await verifyHeartbeatSignature({
      pubkey: pubkeyB64,
      signature: sigB64,
      fields,
    });
    expect(valid).toBe(false);
  });

  it('rejects when fields differ from what was signed', async () => {
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = await ed.getPublicKeyAsync(privKey);
    const pubkeyB64 = Buffer.from(pubKey).toString('base64');

    const fields = { pubkey: pubkeyB64, timestamp: '2026-04-01T00:00:00.000Z' };
    const message = new TextEncoder().encode(canonicalJson(fields));
    const sig = await ed.signAsync(message, privKey);
    const sigB64 = Buffer.from(sig).toString('base64');

    // Verify with different fields
    const valid = await verifyHeartbeatSignature({
      pubkey: pubkeyB64,
      signature: sigB64,
      fields: { ...fields, timestamp: '2026-04-02T00:00:00.000Z' },
    });
    expect(valid).toBe(false);
  });
});

describe('validateTimestamp', () => {
  it('accepts a timestamp within tolerance', () => {
    const ts = new Date().toISOString();
    const result = validateTimestamp(ts, 30);
    expect(result.valid).toBe(true);
  });

  it('rejects a timestamp outside tolerance', () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const result = validateTimestamp(ts, 30);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('from server time');
  });

  it('rejects invalid timestamp format', () => {
    const result = validateTimestamp('not-a-date', 30);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid timestamp format');
  });

  it('enforces monotonic when lastHeartbeat is provided', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 1000).toISOString();
    const result = validateTimestamp(earlier, 30, now.toISOString());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('greater than last heartbeat');
  });

  it('accepts a timestamp greater than lastHeartbeat', () => {
    const now = new Date();
    const later = new Date(now.getTime() + 1000).toISOString();
    // lastHeartbeat is slightly in the past
    const lastHb = new Date(now.getTime() - 5000).toISOString();
    const result = validateTimestamp(later, 30, lastHb);
    expect(result.valid).toBe(true);
  });
});
