import type { Challenge, DiditWithEmailMetadata, DiditWithEmailState } from '../types.js';

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
  /** Server-only state of a `didit_with_email` challenge. */
  link?: LinkChallengeData;
}

/** A Didit session recorded on a `didit_with_email` challenge. */
export interface DiditAttempt {
  session_id: string;
  /** Didit's status name at the last read. */
  status: string;
  recorded_at: number;
  read_at: number;
  /** The `didit.workflow_id` this service recorded the session under. */
  workflow_id?: string;
  /** Didit no longer has this session, or it no longer belongs to this join. */
  gone?: boolean;
}

export interface LinkChallengeData {
  state: DiditWithEmailState;
  /** Keyed hash of the address the link went to. */
  subject_id: string;
  /** The network the email named. */
  network_name: string;
  /** SHA-256 of every link token emailed for this challenge. */
  token_hashes: string[];
  /** SHA-256 of the done page's credential. */
  done_hash: string;
  /** Earliest time a resend can succeed. */
  resend_at: number;
  attempt?: DiditAttempt;
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

/** What `didit_with_email` needs from a session store, beyond SessionStore. */
export interface LinkSessionStore extends SessionStore {
  /** The session holding this link token hash or done hash, in any status, until it expires or is deleted. */
  findByLinkHash(hash: string): Promise<SessionData | null>;
  /**
   * Gives `wait` each key's events within `ttlMs`, oldest first, and records
   * an event at `at` under every key unless `wait` returns a positive delay.
   * Returns that delay, or 0 once recorded. Events must be visible to every
   * service instance. KV can take 60 seconds or more to list a new key, so on
   * KV, reservations close together can miss each other and each pass, and
   * ones made at the same moment can each be refused.
   */
  reserveEvents(keys: string[], at: number, ttlMs: number, wait: (earlier: number[][]) => number): Promise<number>;
  /** Gives back one event that this store recorded at `at`, from every key. */
  removeEvents(keys: string[], at: number): Promise<void>;
}

export function isLinkSessionStore(store: SessionStore): store is LinkSessionStore {
  return 'findByLinkHash' in store && 'reserveEvents' in store && 'removeEvents' in store;
}

/**
 * A pending session expires at a fixed time: its creation plus the pending
 * TTL, or the expiry of the `didit_with_email` challenge it holds.
 */
export function pendingExpiresAt(session: SessionData, pendingTtlMs: number): number {
  const link = session.challenges.find((cs) => cs.link);
  return link ? link.expires_at : session.created_at + pendingTtlMs;
}

export function isExpired(session: SessionData, pendingTtlMs: number): boolean {
  return session.status !== 'ready' && Date.now() > pendingExpiresAt(session, pendingTtlMs);
}

export function holdsLink(session: SessionData): boolean {
  return session.challenges.some((cs) => cs.link);
}

export function linkHashes(session: SessionData): string[] {
  return session.challenges.flatMap((cs) => (cs.link ? [...cs.link.token_hashes, cs.link.done_hash] : []));
}

export function holdsLinkHash(session: SessionData | null, hash: string): session is SessionData {
  return session !== null && linkHashes(session).includes(hash);
}

export function withoutOne(times: number[], at: number): number[] {
  const i = times.indexOf(at);
  return i < 0 ? times : [...times.slice(0, i), ...times.slice(i + 1)];
}

export function linkMetadata(link: LinkChallengeData): DiditWithEmailMetadata {
  return { state: link.state, resend_available_at: new Date(link.resend_at).toISOString() };
}

/** `existing` with `data` written over it, keeping the progress of every link challenge. */
export function applyUpdate(existing: SessionData, data: Partial<SessionData>): SessionData {
  const updated = { ...existing, ...data };
  if (data.challenges) updated.challenges = mergeLinkProgress(existing.challenges, data.challenges);
  return updated;
}

/**
 * Two writers can race on a store with no compare-and-swap. A link
 * challenge's progress never goes back: a completion is kept from either
 * side, its recorded Didit session changes only to a newer one, and every
 * token it emailed keeps working. On KV this holds only against what the
 * read returned, since a KV read can be stale.
 */
function mergeLinkProgress(existing: ChallengeState[], incoming: ChallengeState[]): ChallengeState[] {
  return incoming.map((next) => {
    const prev = existing.find((cs) => cs.challenge.id === next.challenge.id);
    if (!prev?.link || !next.link) return next;
    const kept = prev.completed !== next.completed ? (prev.completed ? prev : next) : laterProgress(prev, next);
    const link: LinkChallengeData = {
      ...kept.link!,
      token_hashes: [...new Set([...prev.link.token_hashes, ...next.link.token_hashes])],
      resend_at: Math.max(prev.link.resend_at, next.link.resend_at),
    };
    return {
      ...kept,
      attempts: Math.max(prev.attempts, next.attempts),
      challenge: { ...kept.challenge, metadata: { ...linkMetadata(link) } },
      link,
    };
  });
}

function laterProgress(prev: ChallengeState, next: ChallengeState): ChallengeState {
  const a = prev.link?.attempt;
  const b = next.link?.attempt;
  if (!a) return next;
  if (!b) return prev;
  if (a.session_id === b.session_id) return a.read_at > b.read_at ? prev : next;
  return a.recorded_at > b.recorded_at ? prev : next;
}
