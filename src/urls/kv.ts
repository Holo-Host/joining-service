import type { HttpGateway } from '../types.js';
import type { LinkerRegistration } from '../linker-auth/types.js';
import type { UrlProvider } from './provider.js';
import type { LinkerRegistrationStore } from '../linker-registration/store.js';
import { toLinkerRegistration } from '../linker-registration/types.js';

/** Cloudflare KV namespace binding (subset of the Workers runtime type). */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
}

/**
 * UrlProvider backed by Cloudflare Workers KV.
 *
 * Reads the current linker and gateway URL lists from KV at request time,
 * so updates written to KV are reflected without redeploying the worker.
 *
 * Expected KV keys:
 *   `linker_registrations` — JSON-encoded LinkerRegistration[]
 *   `http_gateways`        — JSON-encoded HttpGateway[]
 *
 * When a LinkerRegistrationStore is provided, dynamically registered linkers
 * are merged with static registrations. Static entries take precedence
 * when the same linker_url appears in both sources.
 */
export class KvUrlProvider implements UrlProvider {
  constructor(
    private readonly kv: KVNamespace,
    private readonly registrationStore?: LinkerRegistrationStore,
  ) {}

  async getLinkerRegistrations(): Promise<LinkerRegistration[] | undefined> {
    // Static registrations from KV
    const raw = await this.kv.get('linker_registrations');
    const staticEntries: LinkerRegistration[] = raw ? JSON.parse(raw) : [];

    // Dynamic registrations from heartbeating linkers
    let dynamicEntries: LinkerRegistration[] = [];
    if (this.registrationStore) {
      const linkers = await this.registrationStore.listLinkers();
      dynamicEntries = linkers.map(toLinkerRegistration);
    }

    if (staticEntries.length === 0 && dynamicEntries.length === 0) {
      return undefined;
    }

    // Merge: static wins on URL collision
    const seen = new Set(staticEntries.map((r) => r.linker_url.url));
    const merged = [
      ...staticEntries,
      ...dynamicEntries.filter((r) => !seen.has(r.linker_url.url)),
    ];

    return merged.length ? merged : undefined;
  }

  async getHttpGateways(): Promise<HttpGateway[] | undefined> {
    const raw = await this.kv.get('http_gateways');
    if (!raw) return undefined;
    const entries = JSON.parse(raw) as HttpGateway[];
    return entries.length ? entries : undefined;
  }
}
