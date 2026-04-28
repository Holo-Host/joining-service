import { randomBytes } from 'node:crypto';
import type { LinkerCapability, LinkerRegistration } from '../linker-auth/types.js';

/** An invitation token that authorizes a linker to register. */
export interface LinkerInvite {
  token: string;
  label?: string;
  capabilities: LinkerCapability[];
  max_uses?: number;
  used_by: string[];
  created_at: string;
  expires_at?: string;
}

/** A linker that has registered via heartbeat. */
export interface RegisteredLinker {
  pubkey: string;
  invite_token: string;
  label?: string;
  capabilities: LinkerCapability[];
  admin_secret: string;
  linker_url: string;
  admin_url: string;
  last_heartbeat: string;
}

/** Convert a RegisteredLinker to the existing LinkerRegistration type. */
export function toLinkerRegistration(r: RegisteredLinker): LinkerRegistration {
  return {
    linker_url: { url: r.linker_url },
    admin: { url: r.admin_url, secret: r.admin_secret },
  };
}

/** Generate a random invite token with `lnk_` prefix. */
export function generateInviteToken(): string {
  return `lnk_${randomBytes(16).toString('hex')}`;
}
