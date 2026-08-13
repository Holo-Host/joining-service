export interface RegisteredAgent {
  agent_key: string;            // base64 39-byte AgentPubKey
  label?: string;               // operator-facing note, e.g. "acme-net progenitor"
  registered_at: string;        // ISO 8601
}

export interface AllowedAgentStore {
  put(agent: RegisteredAgent): Promise<void>;   // idempotent upsert by agent_key
  get(agentKey: string): Promise<RegisteredAgent | null>;
  has(agentKey: string): Promise<boolean>;
  list(): Promise<RegisteredAgent[]>;
  delete(agentKey: string): Promise<void>;      // no-op if absent
}
