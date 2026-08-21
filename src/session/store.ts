import type { Challenge } from '../types.js';

export type SessionStatus = 'ready' | 'pending' | 'rejected';

export interface SessionData {
  id: string;
  agent_key: string;
  status: SessionStatus;
  challenges: ChallengeState[];
  claims: Record<string, string>;
  created_at: number;
  reason?: string;
  /** Named network this session joined, if any. Selects the role set at provision time. */
  network?: string;
}

export interface ChallengeState {
  challenge: Challenge;
  expected_response: string;
  completed: boolean;
  attempts: number;
  expires_at: number;
  /** Challenges sharing the same group are OR alternatives. */
  group?: string;
}

export interface SessionStore {
  create(data: SessionData): Promise<void>;
  get(sessionId: string): Promise<SessionData | null>;
  update(sessionId: string, data: Partial<SessionData>): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /**
   * Session uniqueness is per (agent, network): an agent may hold at most
   * one live session per network, so lookups must match the network scope
   * exactly. `network` undefined matches only sessions with no network
   * (the default, no-network scope) -- it does not match a named network,
   * nor does a named network match the no-network scope.
   */
  findByAgentKey(agentKey: string, network?: string): Promise<SessionData | null>;
  /**
   * Any session for this agent, regardless of network. For call sites whose
   * semantics are service-wide rather than per-network (e.g. reconnect,
   * which refreshes linker/gateway URLs that are not network-scoped).
   */
  findAnyByAgentKey(agentKey: string): Promise<SessionData | null>;
}
