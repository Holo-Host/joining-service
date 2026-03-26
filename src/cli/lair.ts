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

  // Passphrase is piped via stdin to avoid exposing it in /proc/<pid>/cmdline
  const stdout = await execWithStdin(bin, [
    'sign',
    opts.lairUrl,
    pubKeyB64url,
    dataB64url,
  ], opts.passphrase);

  return stdout.trim();
}

/** Run a command, piping input to its stdin, and return stdout. */
function execWithStdin(bin: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`${bin} failed: ${msg}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
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
