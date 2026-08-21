import type { NetworkStore, NetworkRecord } from './store.js';

export class MemoryNetworkStore implements NetworkStore {
  private networks = new Map<string, NetworkRecord>();

  async put(network: NetworkRecord): Promise<void> {
    this.networks.set(network.happ_id, network);
  }
  async get(happId: string): Promise<NetworkRecord | null> {
    return this.networks.get(happId) ?? null;
  }
  async list(): Promise<NetworkRecord[]> {
    return [...this.networks.values()];
  }
  async delete(happId: string): Promise<void> {
    this.networks.delete(happId);
  }
}
