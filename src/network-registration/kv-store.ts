import type { KVNamespace } from '../urls/kv.js';
import type { NetworkStore, NetworkRecord } from './store.js';

const PREFIX = 'network:';

export class KvNetworkStore implements NetworkStore {
  constructor(private readonly kv: KVNamespace) {}

  async put(network: NetworkRecord): Promise<void> {
    await this.kv.put(`${PREFIX}${network.happ_id}`, JSON.stringify(network));
  }
  async get(happId: string): Promise<NetworkRecord | null> {
    const raw = await this.kv.get(`${PREFIX}${happId}`);
    return raw ? (JSON.parse(raw) as NetworkRecord) : null;
  }
  async list(): Promise<NetworkRecord[]> {
    const { keys } = await this.kv.list({ prefix: PREFIX });
    const results: NetworkRecord[] = [];
    for (const { name } of keys) {
      const raw = await this.kv.get(name);
      if (raw) results.push(JSON.parse(raw) as NetworkRecord);
    }
    return results;
  }
  async delete(happId: string): Promise<void> {
    await this.kv.delete(`${PREFIX}${happId}`);
  }
}
