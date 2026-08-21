import type { AllowedAgentStore, RegisteredAgent } from './store.js';

export class MemoryAllowedAgentStore implements AllowedAgentStore {
  private agents = new Map<string, RegisteredAgent>();

  async put(agent: RegisteredAgent): Promise<void> {
    this.agents.set(agent.agent_key, agent);
  }
  async get(agentKey: string): Promise<RegisteredAgent | null> {
    return this.agents.get(agentKey) ?? null;
  }
  async has(agentKey: string): Promise<boolean> {
    return this.agents.has(agentKey);
  }
  async list(): Promise<RegisteredAgent[]> {
    return [...this.agents.values()];
  }
  async delete(agentKey: string): Promise<void> {
    this.agents.delete(agentKey);
  }
}
