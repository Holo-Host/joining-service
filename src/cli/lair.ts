/**
 * Wrapper around the holo-keyutil binary for signing data via a running
 * lair-keystore instance.
 *
 * holo-keyutil connects to the conductor's actual lair process over IPC,
 * so the key material never leaves lair. The CLI passes data in base64url
 * and receives signatures back the same way.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default binary name — can be overridden via --keyutil-bin */
const DEFAULT_KEYUTIL_BIN = 'holo-keyutil';

export interface LairSignerOptions {
  /** Lair IPC connection URL (e.g. unix:///path/to/socket) */
  lairUrl: string;
  /** Lair passphrase (plaintext) */
  passphrase: string;
  /** Path to holo-keyutil binary (default: looks up in PATH) */
  keyutilBin?: string;
}

/**
 * Sign arbitrary data using a key stored in the running lair-keystore.
 *
 * @param pubKeyB64url - Raw 32-byte ed25519 public key as base64url (no padding)
 * @param dataB64url - Data to sign as base64url (no padding)
 * @returns Ed25519 signature as base64url (no padding)
 */
export async function lairSign(
  opts: LairSignerOptions,
  pubKeyB64url: string,
  dataB64url: string,
): Promise<string> {
  const bin = opts.keyutilBin ?? DEFAULT_KEYUTIL_BIN;

  const { stdout } = await execFileAsync(bin, [
    'sign',
    opts.lairUrl,
    opts.passphrase,
    pubKeyB64url,
    dataB64url,
  ]);

  return stdout.trim();
}

/**
 * Extract the raw 32-byte ed25519 public key from a Holochain AgentPubKey.
 *
 * @param agentPubKey - HoloHash-format agent key (e.g. uhCAk...)
 * @returns Raw 32-byte key as base64url (no padding)
 */
export async function extractPubKey(
  agentPubKey: string,
  keyutilBin?: string,
): Promise<string> {
  const bin = keyutilBin ?? DEFAULT_KEYUTIL_BIN;

  const { stdout } = await execFileAsync(bin, [
    'extract-pubkey',
    agentPubKey,
  ]);

  return stdout.trim();
}
