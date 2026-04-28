import * as ed from '@noble/ed25519';

/**
 * Produce a canonical JSON string: sorted keys, no whitespace.
 * This is the deterministic format used for heartbeat signatures.
 */
export function canonicalJson(obj: Record<string, string>): string {
  const sorted = Object.keys(obj).sort();
  const entries: Record<string, string> = {};
  for (const key of sorted) {
    entries[key] = obj[key];
  }
  return JSON.stringify(entries);
}

/**
 * Verify an ed25519 signature over canonical JSON fields.
 * @returns true if the signature is valid
 */
export async function verifyHeartbeatSignature(params: {
  pubkey: string;
  signature: string;
  fields: Record<string, string>;
}): Promise<boolean> {
  try {
    const pubkeyBytes = Buffer.from(params.pubkey, 'base64');
    const sigBytes = Buffer.from(params.signature, 'base64');
    const message = new TextEncoder().encode(canonicalJson(params.fields));
    return await ed.verifyAsync(sigBytes, message, pubkeyBytes);
  } catch {
    return false;
  }
}

/**
 * Validate a heartbeat timestamp:
 * 1. Must be valid ISO 8601
 * 2. Must be within ±toleranceSeconds of now
 * 3. If lastHeartbeat provided, must be strictly greater (monotonic)
 */
export function validateTimestamp(
  timestamp: string,
  toleranceSeconds: number,
  lastHeartbeat?: string,
): { valid: boolean; error?: string } {
  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const drift = Math.abs(Date.now() - ts.getTime());
  if (drift > toleranceSeconds * 1000) {
    return {
      valid: false,
      error: `Timestamp is ${Math.round(drift / 1000)}s from server time (max ${toleranceSeconds}s)`,
    };
  }

  if (lastHeartbeat) {
    const lastTs = new Date(lastHeartbeat);
    if (ts.getTime() <= lastTs.getTime()) {
      return { valid: false, error: 'Timestamp must be greater than last heartbeat' };
    }
  }

  return { valid: true };
}
