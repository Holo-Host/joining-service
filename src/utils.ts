import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2.js';
import * as ed from '@noble/ed25519';

export function generateSessionId(): string {
  return `js_${randomBytes(16).toString('hex')}`;
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

/**
 * Decode a HoloHash base64 string ("u" + base64url) to raw bytes.
 * Matches `decodeHashFromBase64` from `@holochain/client`.
 */
export function decodeHashFromBase64(hash: string): Uint8Array {
  return new Uint8Array(Buffer.from(hash.slice(1), 'base64url'));
}

/**
 * Encode raw hash bytes to a HoloHash base64 string ("u" + base64url).
 * Matches `encodeHashToBase64` from `@holochain/client`.
 */
export function encodeHashToBase64(hash: Uint8Array): string {
  return `u${Buffer.from(hash).toString('base64url')}`;
}

const AGENT_KEY_PREFIX = new Uint8Array([0x84, 0x20, 0x24]);

/**
 * Compute the 4-byte DHT location from a 32-byte hash core.
 * Matches Holochain's `holo_dht_location_bytes`: blake2b-128 then XOR-fold to 4 bytes.
 */
export function dhtLocationFrom32(hashCore: Uint8Array): Uint8Array {
  const hash = blake2b(hashCore, { dkLen: 16 });
  const out = new Uint8Array([hash[0], hash[1], hash[2], hash[3]]);
  for (let i = 4; i < 16; i += 4) {
    out[0] ^= hash[i];
    out[1] ^= hash[i + 1];
    out[2] ^= hash[i + 2];
    out[3] ^= hash[i + 3];
  }
  return out;
}

/**
 * Build a 39-byte AgentPubKey from a 32-byte ed25519 public key.
 * Layout: [3-byte prefix][32-byte key][4-byte DHT location]
 */
export function agentPubKeyFrom32(ed25519PubKey: Uint8Array): Uint8Array {
  if (ed25519PubKey.length !== 32) {
    throw new Error(`Expected 32-byte ed25519 key, got ${ed25519PubKey.length}`);
  }
  const loc = dhtLocationFrom32(ed25519PubKey);
  const result = new Uint8Array(39);
  result.set(AGENT_KEY_PREFIX, 0);
  result.set(ed25519PubKey, 3);
  result.set(loc, 35);
  return result;
}

/**
 * Extract the raw 32-byte Ed25519 public key from a Holochain AgentPubKey and
 * return it as base64url (no padding), which is the format expected by
 * hc-auth-server.
 *
 * HoloHash layout: [3 bytes prefix][32 bytes key][4 bytes DHT location]
 */
export function agentKeyToRawEd25519Base64url(agentKey: string): string {
  const bytes = decodeHashFromBase64(agentKey);
  if (bytes.length !== 39) {
    throw new Error(`agentKey must be 39 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes.slice(3, 35)).toString('base64url');
}

/**
 * An agent key whose string is its one canonical encoding, carrying the DHT
 * location of its core key, which must be a curve point with no small order:
 * a small-order key verifies a fixed signature for any message.
 */
export function isCanonicalAgentKey(agentKey: string): boolean {
  if (!/^u[A-Za-z0-9_-]{52}$/.test(agentKey) || !validateAgentKey(agentKey).valid) return false;
  const bytes = decodeHashFromBase64(agentKey);
  const core = bytes.slice(3, 35);
  if (!dhtLocationFrom32(core).every((b, i) => b === bytes[35 + i])) return false;
  try {
    return !ed.Point.fromHex(core).isSmallOrder();
  } catch {
    return false;
  }
}

export function validateAgentKey(agentKey: string): {
  valid: boolean;
  reason?: string;
} {
  let bytes: Uint8Array;
  try {
    bytes = decodeHashFromBase64(agentKey);
  } catch {
    return { valid: false, reason: 'Agent key is not valid HoloHash base64' };
  }

  if (bytes.length !== 39) {
    return {
      valid: false,
      reason: `Agent key must be 39 bytes, got ${bytes.length}`,
    };
  }

  if (
    bytes[0] !== AGENT_KEY_PREFIX[0] ||
    bytes[1] !== AGENT_KEY_PREFIX[1] ||
    bytes[2] !== AGENT_KEY_PREFIX[2]
  ) {
    return {
      valid: false,
      reason: 'Agent key does not have valid AgentPubKey prefix',
    };
  }

  return { valid: true };
}
