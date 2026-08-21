import type { KVNamespace } from '../urls/kv.js';
import type { AllowedAgentStore, RegisteredAgent } from './store.js';

const PREFIX = 'allowed_agent:';

export class KvAllowedAgentStore implements AllowedAgentStore {
  constructor(private readonly kv: KVNamespace) {}

  async put(agent: RegisteredAgent): Promise<void> {
    await this.kv.put(`${PREFIX}${agent.agent_key}`, JSON.stringify(agent));
  }
  async get(agentKey: string): Promise<RegisteredAgent | null> {
    const raw = await this.kv.get(`${PREFIX}${agentKey}`);
    return raw ? (JSON.parse(raw) as RegisteredAgent) : null;
  }
  async has(agentKey: string): Promise<boolean> {
    return (await this.get(agentKey)) !== null;
  }
  async list(): Promise<RegisteredAgent[]> {
    const { keys } = await this.kv.list({ prefix: PREFIX });
    const results: RegisteredAgent[] = [];
    for (const { name } of keys) {
      const raw = await this.kv.get(name);
      if (raw) results.push(JSON.parse(raw) as RegisteredAgent);
    }
    return results;
  }
  async delete(agentKey: string): Promise<void> {
    await this.kv.delete(`${PREFIX}${agentKey}`);
  }
}
