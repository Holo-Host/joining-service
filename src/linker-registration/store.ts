import type { KVNamespace } from '../urls/kv.js';
import type { LinkerInvite, RegisteredLinker } from './types.js';

const INVITE_PREFIX = 'linker_invite:';
const LINKER_PREFIX = 'registered_linker:';

/**
 * KV-backed storage for linker invites and registered linkers.
 */
export class LinkerRegistrationStore {
  constructor(private readonly kv: KVNamespace) {}

  // ---- Invites ----

  async createInvite(invite: LinkerInvite): Promise<void> {
    await this.kv.put(`${INVITE_PREFIX}${invite.token}`, JSON.stringify(invite));
  }

  async getInvite(token: string): Promise<LinkerInvite | null> {
    const raw = await this.kv.get(`${INVITE_PREFIX}${token}`);
    return raw ? (JSON.parse(raw) as LinkerInvite) : null;
  }

  async listInvites(): Promise<LinkerInvite[]> {
    const { keys } = await this.kv.list({ prefix: INVITE_PREFIX });
    const results: LinkerInvite[] = [];
    for (const { name } of keys) {
      const raw = await this.kv.get(name);
      if (raw) results.push(JSON.parse(raw) as LinkerInvite);
    }
    return results;
  }

  async deleteInvite(token: string): Promise<void> {
    await this.kv.delete(`${INVITE_PREFIX}${token}`);
  }

  // ---- Registered Linkers ----

  async putLinker(linker: RegisteredLinker, ttlSeconds: number): Promise<void> {
    await this.kv.put(
      `${LINKER_PREFIX}${linker.pubkey}`,
      JSON.stringify(linker),
      { expirationTtl: ttlSeconds },
    );
  }

  async getLinker(pubkey: string): Promise<RegisteredLinker | null> {
    const raw = await this.kv.get(`${LINKER_PREFIX}${pubkey}`);
    return raw ? (JSON.parse(raw) as RegisteredLinker) : null;
  }

  async listLinkers(): Promise<RegisteredLinker[]> {
    const { keys } = await this.kv.list({ prefix: LINKER_PREFIX });
    const results: RegisteredLinker[] = [];
    for (const { name } of keys) {
      const raw = await this.kv.get(name);
      if (raw) results.push(JSON.parse(raw) as RegisteredLinker);
    }
    return results;
  }

  async deleteLinker(pubkey: string): Promise<void> {
    await this.kv.delete(`${LINKER_PREFIX}${pubkey}`);
  }
}
