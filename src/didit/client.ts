import { createHmac } from 'node:crypto';
import type { DiditWithEmailState } from '../types.js';

const API = 'https://verification.didit.me';
const TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_KEY_RE = /^[0-9a-f]{64}$/i;

export interface DiditConfig {
  /** A named console key with Sessions write and Decisions read, never the primary secret. */
  api_key: string;
  /** 32 random bytes, hex. It never rotates: a new key hides every earlier verification. */
  subject_key: string;
  workflow_id: string;
  environment: 'live' | 'sandbox';
  max_sessions_per_email?: number;
  max_sessions_per_day?: number;
  link_ttl_seconds?: number;
  resend_interval_seconds?: number;
  max_emails_per_address?: number;
  max_emails_per_agent?: number;
  email_subject?: string;
  email_template?: string;
}

const LIMIT_DEFAULTS = {
  max_sessions_per_email: 3,
  max_sessions_per_day: 100,
  link_ttl_seconds: 604_800,
  resend_interval_seconds: 60,
  max_emails_per_address: 5,
  max_emails_per_agent: 5,
};

export type ResolvedDiditConfig = DiditConfig & typeof LIMIT_DEFAULTS;

export function resolveDiditConfig(raw: Partial<DiditConfig> | undefined): ResolvedDiditConfig {
  if (!raw) throw new Error('config: didit_with_email requires a didit block');
  if (!raw.api_key) throw new Error('config: didit_with_email requires didit.api_key');
  if (!raw.subject_key || !SUBJECT_KEY_RE.test(raw.subject_key)) {
    throw new Error('config: didit_with_email requires didit.subject_key, 32 bytes as 64 hex characters');
  }
  if (!raw.workflow_id || !UUID_RE.test(raw.workflow_id)) {
    throw new Error('config: didit_with_email requires didit.workflow_id, a UUID');
  }
  if (raw.environment !== 'live' && raw.environment !== 'sandbox') {
    throw new Error('config: didit.environment must be "live" or "sandbox"');
  }
  if (raw.email_template !== undefined && !raw.email_template.includes('{{link}}')) {
    throw new Error('config: didit.email_template must contain {{link}}');
  }
  if (raw.email_subject?.includes('{{link}}')) {
    throw new Error('config: didit.email_subject must not contain {{link}}, which would put the token in the subject');
  }
  const resolved = { ...LIMIT_DEFAULTS, ...raw } as ResolvedDiditConfig;
  for (const key of Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[]) {
    if (!Number.isInteger(resolved[key]) || resolved[key] <= 0) {
      throw new Error(`config: didit.${key} must be a positive integer`);
    }
  }
  return resolved;
}

/**
 * Didit's `vendor_data` for an email, and the key of its email limits: the
 * keyed hash of the address after trimming and lower-casing ASCII letters,
 * as hc-auth compares emails.
 */
export function subjectId(email: string, subjectKeyHex: string): string {
  const normalized = email.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return keyedHash(normalized, subjectKeyHex).toString('hex');
}

export function keyedHash(data: string, keyHex: string): Buffer {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data).digest();
}

const STATES = new Map<string, Exclude<DiditWithEmailState, 'link_sent'>>([
  ['Not Started', 'in_progress'],
  ['In Progress', 'in_progress'],
  ['Resubmitted', 'in_progress'],
  ['Awaiting User', 'in_progress'],
  ['In Review', 'in_review'],
  ['Declined', 'declined'],
  ['Expired', 'expired'],
  ['Abandoned', 'expired'],
  ['Kyc Expired', 'expired'],
  ['Approved', 'approved'],
]);

export function stateOf(status: string): Exclude<DiditWithEmailState, 'link_sent'> | undefined {
  return STATES.get(status);
}

export interface CreatedSession {
  session_id: string;
  url: string;
  status: string;
}

/** The fields of a decision this service reads. Nothing else is kept. */
export interface Decision {
  session_id: string;
  status: string;
  workflow_id?: string;
  vendor_data?: string;
  environment?: string;
  agent_key?: string;
}

export type DecisionField = 'workflow_id' | 'vendor_data' | 'environment' | 'metadata.agent_key';

/** A decision naming another workflow or environment points at this service's configuration, not at the join. */
export function isConfigField(field: DecisionField): field is 'workflow_id' | 'environment' {
  return field === 'workflow_id' || field === 'environment';
}

export interface ListedSessions {
  count: number;
  sessions: { session_id: string; status: string }[];
}

/** Any Didit failure: no answer, a non-success status, or an unreadable body. */
export class DiditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiditUnavailableError';
  }
}

/**
 * Didit's session API. Logs carry operation names, HTTP statuses, session
 * ids and Didit status names only: never a response body, a URL or a token.
 */
export class DiditClient {
  constructor(readonly config: ResolvedDiditConfig) {}

  /** Creates a session, or returns the open one Didit already holds for this `vendor_data`. */
  async createSession(request: {
    vendorData: string;
    callback: string;
    agentKey: string;
  }): Promise<CreatedSession> {
    const res = await this.call('create', '/v3/session/', {
      method: 'POST',
      body: JSON.stringify({
        workflow_id: this.config.workflow_id,
        vendor_data: request.vendorData,
        callback: request.callback,
        callback_method: 'both',
        metadata: { agent_key: request.agentKey },
      }),
    });
    if (!res.ok) throw this.refused('create', res.status);
    const body = await this.json('create', res);
    if (typeof body.url !== 'string' || !body.url) {
      console.error('[didit] create returned no url: the API key needs Sessions write');
      throw new DiditUnavailableError('Didit create returned no url');
    }
    if (typeof body.session_id !== 'string' || typeof body.status !== 'string') {
      throw new DiditUnavailableError('Didit create returned an unexpected body');
    }
    return {
      session_id: body.session_id,
      url: body.url,
      status: body.status,
    };
  }

  /** The session's decision, or null when Didit no longer has the session. */
  async decision(sessionId: string): Promise<Decision | null> {
    const res = await this.call('decision', `/v3/session/${encodeURIComponent(sessionId)}/decision/`);
    if (res.status === 404) return null;
    if (!res.ok) throw this.refused('decision', res.status);
    const body = await this.json('decision', res);
    if (typeof body.status !== 'string') {
      throw new DiditUnavailableError('Didit decision returned an unexpected body');
    }
    const metadata = body.metadata as Record<string, unknown> | null | undefined;
    return {
      session_id: sessionId,
      status: body.status,
      workflow_id: str(body.workflow_id),
      vendor_data: str(body.vendor_data),
      environment: str(body.environment),
      agent_key: str(metadata?.agent_key),
    };
  }

  /** This workflow's sessions for a `vendor_data`, newest first. */
  async listSessions(vendorData: string): Promise<ListedSessions> {
    const query = new URLSearchParams({ vendor_data: vendorData, workflow_id: this.config.workflow_id });
    const res = await this.call('list', `/v3/sessions/?${query}`);
    if (!res.ok) throw this.refused('list', res.status);
    const body = await this.json('list', res);
    if (typeof body.count !== 'number' || !Array.isArray(body.results)) {
      throw new DiditUnavailableError('Didit list returned an unexpected body');
    }
    const sessions = (body.results as Record<string, unknown>[])
      .filter((row) => typeof row.session_id === 'string' && typeof row.status === 'string')
      .map((row) => ({ session_id: row.session_id as string, status: row.status as string }));
    return { count: body.count, sessions };
  }

  /**
   * The first field naming another workflow, email, environment or agent key
   * than this join's, or undefined when the decision belongs to the join.
   */
  mismatch(decision: Decision, expected: { vendorData: string; agentKey: string }): DecisionField | undefined {
    if (decision.workflow_id !== this.config.workflow_id) return 'workflow_id';
    if (decision.vendor_data !== expected.vendorData) return 'vendor_data';
    if (decision.environment !== this.config.environment) return 'environment';
    if (decision.agent_key !== expected.agentKey) return 'metadata.agent_key';
    return undefined;
  }

  private async call(op: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { 'x-api-key': this.config.api_key };
    if (init.body) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new DiditUnavailableError(`Didit ${op} failed: ${failureName(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      console.error(`[didit] ${op} answered ${res.status}: check didit.api_key and its scopes`);
    }
    return res;
  }

  private refused(op: string, status: number): DiditUnavailableError {
    if (status !== 429 && status < 500 && status !== 401 && status !== 403) {
      console.error(`[didit] ${op} answered ${status}: check didit.workflow_id and the key's workflow access`);
    }
    return new DiditUnavailableError(`Didit ${op} answered ${status}`);
  }

  private async json(op: string, res: Response): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new DiditUnavailableError(`Didit ${op} body could not be read: ${failureName(err)}`);
    }
    if (body && typeof body === 'object') return body as Record<string, unknown>;
    throw new DiditUnavailableError(`Didit ${op} returned an unexpected body`);
  }
}

/** The error's name and its cause's code, such as `TypeError ENOTFOUND`: never its message, which can carry a URL. */
function failureName(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
