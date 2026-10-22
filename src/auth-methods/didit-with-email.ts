import { createHash, randomBytes } from 'node:crypto';
import type { EmailTransport } from '../email/transport.js';
import type { Challenge, DiditWithEmailState } from '../types.js';
import {
  linkMetadata,
  type ChallengeState,
  type DiditAttempt,
  type LinkChallengeData,
  type LinkSessionStore,
  type SessionData,
} from '../session/store.js';
import {
  DiditUnavailableError,
  isConfigField,
  stateOf,
  subjectId,
  type DecisionField,
  type DiditClient,
  type Decision,
  type ResolvedDiditConfig,
} from '../didit/client.js';
import { JoinRequestError, type AuthMethodPlugin, type JoinContext } from './plugin.js';
import { maskEmail } from './email-code.js';
import { isCanonicalAgentKey } from '../utils.js';

const DAY_MS = 86_400_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** One printable ASCII address with no space, display name, list separator, quoting or path separator, as one recipient for every provider. */
const PLAIN_EMAIL_RE = /^[!#-'*+\-.0-9=?A-Z^-~]+@[!#-'*+\-.0-9=?A-Z^-~]+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * How long one decision read, or one failed read, serves status, resume and
 * the done page, by the state it found. A state with no interval is not read
 * again.
 */
const READ_INTERVAL_MS: Partial<Record<DiditWithEmailState, number>> = {
  in_progress: 15_000,
  in_review: 60_000,
  declined: 300_000,
  expired: 300_000,
};

/** The order Continue takes an email's listed sessions in. A state with no rank is skipped. */
const LISTED_RANK: Partial<Record<DiditWithEmailState, number>> = {
  approved: 0,
  in_review: 1,
  in_progress: 2,
};

export const NO_ATTEMPTS_LEFT =
  'This email address has no identity verification attempts left. Contact support.';

const DEFAULT_SUBJECT = 'Verify your identity to join {{network}}';
const DEFAULT_TEMPLATE = `Someone started joining {{network}} with this email address.

This request is for the device with agent key {{agent_key}}. Continue only if that is the key shown in your app.

To finish, open this link and verify your identity with Didit:
{{link}}

You can open the link on this device or on your phone. It works until {{expires_at}}.

If you did not start this, ignore this email. Do not verify your identity for a join that you did not start.`;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type ContinueOutcome =
  | { kind: 'redirect'; url: string }
  | { kind: 'approved' }
  | { kind: 'in_review' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

type Reading = 'approved' | 'in_review' | 'open' | 'over' | 'gone' | 'unknown';

export interface DiditWithEmailDeps {
  client: DiditClient;
  store: LinkSessionStore;
  transport: EmailTransport;
  baseUrl: string;
  happName: string;
}

/** An agent key shortened as the app shows it. */
export function shortAgentKey(agentKey: string): string {
  return `${agentKey.slice(0, 8)}…${agentKey.slice(-6)}`;
}

/** A time as `28 October 2026, 14:02 UTC`. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Moves a `didit_with_email` challenge's server-only state out of the metadata clients see. */
export function takeLink(ch: Challenge): { link?: LinkChallengeData } {
  const link = ch.metadata?.link as LinkChallengeData | undefined;
  if (!link) return {};
  delete ch.metadata!.link;
  return { link };
}

export function pollIntervalMs(challenges: ChallengeState[]): number {
  const links = challenges.filter((cs) => cs.link);
  if (links.length === 0) return 2000;
  return links.some((cs) => !cs.completed && cs.link!.state === 'in_review') ? 60_000 : 5000;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(network|link|expires_at|agent_key)\}\}/g, (_, key: string) => values[key]);
}

function unknownStatus(status: string): string {
  return `unknown status ${JSON.stringify(status.slice(0, 40))}`;
}

/** An error's message up to its first `:`, so a provider's response body, which can name the recipient, stays out of the log. */
function errorHead(err: unknown): string {
  return err instanceof Error ? err.message.split(':')[0] : 'unknown error';
}

/** Runs a store step, answering a failure as 503 rather than as a refused claim. */
async function storeStep<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    console.error(`[didit_with_email] could not ${what}:`, err);
    throw new JoinRequestError(503, 'service_unavailable', 'The service could not record the email. Try again in a few minutes.');
  }
}

function setState(cs: ChallengeState, state: DiditWithEmailState): void {
  cs.link!.state = state;
  cs.challenge.metadata = { ...linkMetadata(cs.link!) };
}

function approve(cs: ChallengeState): void {
  cs.completed = true;
  setState(cs, 'approved');
}

/**
 * Identity verification by an emailed link and a Didit session. The link
 * proves the email; Didit's decision completes the challenge.
 */
export class DiditWithEmailAuthMethod implements AuthMethodPlugin {
  type = 'didit_with_email';

  private readonly client: DiditClient;
  private readonly store: LinkSessionStore;
  private readonly transport: EmailTransport;
  private readonly config: ResolvedDiditConfig;
  private readonly baseUrl: string;
  private readonly happName: string;

  constructor(deps: DiditWithEmailDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.transport = deps.transport;
    this.config = deps.client.config;
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.happName = deps.happName;
  }

  async createChallenges(
    agentKey: string,
    claims: Record<string, string>,
    _config: unknown,
    joinContext?: JoinContext,
  ): Promise<Challenge[]> {
    // The person checks the emailed short key, so it must name exactly one key.
    if (!isCanonicalAgentKey(agentKey)) {
      throw new JoinRequestError(400, 'invalid_agent_key', 'agent_key must be an AgentPubKey in canonical form');
    }
    const email = claims.email;
    if (!email) {
      throw new Error('email claim is required for didit_with_email auth');
    }
    const address = typeof email === 'string' ? email.trim() : '';
    if (address.length > MAX_EMAIL_LENGTH || !PLAIN_EMAIL_RE.test(address)) {
      throw new JoinRequestError(400, 'missing_claims', 'email claim must be one plain email address');
    }

    const now = Date.now();
    const network = joinContext?.network;
    const expiresAt = now + this.config.link_ttl_seconds * 1000;
    const link: LinkChallengeData = {
      state: 'link_sent',
      subject_id: subjectId(address, this.config.subject_key),
      network_name: network ? (network.happ?.name ?? network.happ_id) : this.happName,
      token_hashes: [],
      resend_at: now + this.config.resend_interval_seconds * 1000,
    };
    link.token_hashes.push(await this.sendLink(address, agentKey, link, expiresAt, now));

    return [
      {
        id: `ch_didit_${now}`,
        type: 'didit_with_email',
        description: `Open the link we sent to ${maskEmail(address)}`,
        expires_at: new Date(expiresAt).toISOString(),
        metadata: { ...linkMetadata(link), link },
      },
    ];
  }

  async verifyChallengeResponse(): Promise<{ passed: boolean; reason?: string }> {
    return { passed: false, reason: 'Open the link in the email to continue' };
  }

  async findLink(token: string): Promise<{ session: SessionData; cs: ChallengeState } | undefined> {
    if (!TOKEN_RE.test(token)) return undefined;
    const hash = hashToken(token);
    const session = await this.store.findByLinkToken(hash);
    const cs = session?.challenges.find((c) => c.link?.token_hashes.includes(hash));
    return session && cs && Date.now() <= cs.expires_at ? { session, cs } : undefined;
  }

  async resend(session: SessionData, cs: ChallengeState): Promise<void> {
    const link = cs.link!;
    const now = Date.now();
    link.token_hashes.push(await this.sendLink(session.claims.email.trim(), session.agent_key, link, cs.expires_at, now));
    link.resend_at = now + this.config.resend_interval_seconds * 1000;
    setState(cs, link.state);
    await this.save(session);
  }

  async refresh(session: SessionData): Promise<void> {
    let read = false;
    for (const cs of session.challenges) {
      const attempt = cs.link?.attempt;
      if (!attempt || attempt.gone || cs.completed) continue;
      const interval = READ_INTERVAL_MS[cs.link!.state];
      if (interval === undefined || Date.now() - attempt.read_at < interval) continue;
      read = true;
      try {
        this.applyRecorded(session, cs, await this.client.decision(attempt.session_id));
      } catch (err) {
        if (!(err instanceof DiditUnavailableError)) throw err;
        cs.link!.attempt = { ...attempt, read_at: Date.now() };
        console.warn(`[didit_with_email] ${err.message}; serving the stored state`);
      }
    }
    if (read) await this.save(session);
  }

  /**
   * The Continue button: completes from a decision, opens a Didit session for
   * the browser, or rejects the join when the email has no attempts left.
   */
  async continue(session: SessionData, cs: ChallengeState, token: string): Promise<ContinueOutcome> {
    if (cs.completed) return { kind: 'approved' };
    try {
      return (await this.continueRecorded(session, cs, token)) ?? (await this.continueListed(session, cs, token));
    } catch (err) {
      if (!(err instanceof DiditUnavailableError)) throw err;
      console.warn(`[didit_with_email] ${err.message}; Continue changed nothing`);
      return { kind: 'unavailable' };
    }
  }

  private async continueRecorded(
    session: SessionData,
    cs: ChallengeState,
    token: string,
  ): Promise<ContinueOutcome | undefined> {
    const attempt = cs.link!.attempt;
    if (!attempt || attempt.gone) return undefined;
    const reading = this.applyRecorded(session, cs, await this.client.decision(attempt.session_id));
    if (reading === 'approved' || reading === 'in_review') {
      await this.save(session);
      return { kind: reading };
    }
    return reading === 'open' ? this.open(session, cs, token) : undefined;
  }

  private async continueListed(session: SessionData, cs: ChallengeState, token: string): Promise<ContinueOutcome> {
    const link = cs.link!;
    const listed = await this.client.listSessions(link.subject_id);
    const ranked: { session_id: string; rank: number }[] = [];
    let unreadable: string | undefined;
    for (const row of listed.sessions) {
      const state = stateOf(row.status);
      const rank = state && LISTED_RANK[state];
      if (rank !== undefined) ranked.push({ session_id: row.session_id, rank });
      else if (!state) unreadable ??= `listed session ${row.session_id} has ${unknownStatus(row.status)}`;
    }
    ranked.sort((a, b) => a.rank - b.rank);

    for (const row of ranked) {
      const decision = await this.client.decision(row.session_id);
      if (!decision) {
        console.warn(`[didit_with_email] Didit has no listed session ${row.session_id}`);
        continue;
      }
      const state = stateOf(decision.status);
      if (!state) {
        unreadable ??= `listed session ${row.session_id} has ${unknownStatus(decision.status)}`;
        continue;
      }
      const field = this.mismatch(decision, link, session.agent_key);
      if (state === 'in_progress' && (!field || field === 'metadata.agent_key')) {
        return this.open(session, cs, token);
      }
      if (field) console.warn(`[didit_with_email] listed session ${row.session_id} is not this join's: ${field} differs`);
      if (field || (state !== 'approved' && state !== 'in_review')) continue;

      const now = Date.now();
      const attempt: DiditAttempt = {
        session_id: decision.session_id,
        status: decision.status,
        recorded_at: now,
        read_at: now,
        workflow_id: this.config.workflow_id,
      };
      link.attempt = attempt;
      if (state === 'approved') approve(cs);
      else setState(cs, 'in_review');
      await this.save(session);
      return { kind: state };
    }

    if (unreadable) {
      console.error(`[didit_with_email] ${unreadable}, so Continue cannot count this email's attempts`);
      throw new DiditUnavailableError(`Didit ${unreadable}`);
    }
    if (listed.count >= this.config.max_sessions_per_email) {
      console.warn(
        `[didit_with_email] ${listed.count} Didit sessions for this email reach the cap of ${this.config.max_sessions_per_email}; rejecting the join`,
      );
      await this.store.update(session.id, {
        status: 'rejected',
        reason: NO_ATTEMPTS_LEFT,
        challenges: session.challenges,
      });
      return { kind: 'rejected' };
    }
    return this.open(session, cs, token);
  }

  /** Creates a session, or takes over the email's open one, and records it on the challenge. */
  private async open(session: SessionData, cs: ChallengeState, token: string): Promise<ContinueOutcome> {
    const link = cs.link!;
    const created = await this.client.createSession({
      vendorData: link.subject_id,
      callback: `${this.linkUrl(token)}/done`,
      agentKey: session.agent_key,
    });
    const now = Date.now();
    const prev = link.attempt;
    const same = prev?.session_id === created.session_id;
    link.attempt = {
      session_id: created.session_id,
      status: created.status,
      recorded_at: same ? prev.recorded_at : now,
      read_at: now,
      workflow_id: this.config.workflow_id,
    };
    setState(cs, 'in_progress');
    await this.save(session);
    return { kind: 'redirect', url: created.url };
  }

  /** Applies a read of the recorded session. One that is gone or not this join's is forgotten. */
  private applyRecorded(session: SessionData, cs: ChallengeState, decision: Decision | null): Reading {
    const link = cs.link!;
    const reading = this.reading(session, link, link.attempt!.session_id, decision);
    const attempt: DiditAttempt = { ...link.attempt!, read_at: Date.now() };
    link.attempt = attempt;
    if (reading === 'gone') {
      attempt.gone = true;
      setState(cs, 'link_sent');
    } else if (reading !== 'unknown') {
      attempt.status = decision!.status;
      if (reading === 'approved') approve(cs);
      else setState(cs, stateOf(decision!.status)!);
    }
    return reading;
  }

  private reading(session: SessionData, link: LinkChallengeData, sessionId: string, decision: Decision | null): Reading {
    if (!decision) {
      console.warn(`[didit_with_email] Didit has no session ${sessionId}`);
      return 'gone';
    }
    const field = this.mismatch(decision, link, session.agent_key);
    if (field) {
      console.warn(`[didit_with_email] session ${sessionId} is not this join's: ${field} differs`);
      return 'gone';
    }
    const state = stateOf(decision.status);
    if (!state) {
      console.warn(`[didit_with_email] session ${sessionId} has ${unknownStatus(decision.status)}`);
      return 'unknown';
    }
    if (state === 'in_progress') return 'open';
    if (state === 'declined' || state === 'expired') return 'over';
    return state;
  }

  /**
   * The decision's mismatched field. One that points at this service's
   * configuration is refused as unavailable, unless the session was recorded
   * under another `didit.workflow_id`.
   */
  private mismatch(decision: Decision, link: LinkChallengeData, agentKey: string): DecisionField | undefined {
    const field = this.client.mismatch(decision, { vendorData: link.subject_id, agentKey });
    if (!field || !isConfigField(field)) return field;
    const recorded = link.attempt?.session_id === decision.session_id ? link.attempt : undefined;
    if (recorded?.workflow_id !== undefined && recorded.workflow_id !== this.config.workflow_id) {
      console.warn(`[didit_with_email] session ${decision.session_id} was recorded under an earlier didit.workflow_id`);
      return field;
    }
    const seen = decision[field];
    console.error(
      `[didit_with_email] session ${decision.session_id} has ${seen === undefined ? `no ${field}` : `${field} ${JSON.stringify(seen)}`}, ` +
        `configured ${JSON.stringify(this.config[field])}: check didit.${field}`,
    );
    throw new DiditUnavailableError(`Didit session ${decision.session_id} has another ${field}`);
  }

  private async sendLink(
    email: string,
    agentKey: string,
    link: LinkChallengeData,
    expiresAt: number,
    now: number,
  ): Promise<string> {
    const keys = [`didit_email:${link.subject_id}`, `didit_agent:${agentKey}`];
    const wait = await storeStep('record an email', () =>
      this.store.reserveEvents(keys, now, DAY_MS, ([toAddress, byAgent]) => this.limitWait(toAddress, byAgent, now)),
    );
    if (wait > 0) {
      throw new JoinRequestError(
        429,
        'rate_limited',
        'Too many emails for this address or agent key. Try again later.',
        Math.ceil(wait / 1000),
      );
    }

    const token = randomBytes(32).toString('base64url');
    const values = {
      network: link.network_name,
      link: this.linkUrl(token),
      expires_at: formatUtc(expiresAt),
      agent_key: shortAgentKey(agentKey),
    };
    try {
      await this.transport.send(
        email,
        fill(this.config.email_subject ?? DEFAULT_SUBJECT, values),
        fill(this.config.email_template ?? DEFAULT_TEMPLATE, values),
      );
    } catch (err) {
      await storeStep('release an email', () => this.store.removeEvents(keys, now)).catch(() => {});
      console.error(`[didit_with_email] email send failed: ${errorHead(err)}`);
      throw new JoinRequestError(503, 'service_unavailable', 'The email could not be sent. Try again in a few minutes.');
    }
    return hashToken(token);
  }

  /**
   * How long until the earlier emails for this agent key and to this address
   * allow one more. An agent key over its limit learns nothing about the address.
   */
  private limitWait(toAddress: number[], byAgent: number[], now: number): number {
    const { max_emails_per_address: perAddress, max_emails_per_agent: perAgent } = this.config;
    if (byAgent.length >= perAgent) return byAgent[byAgent.length - perAgent] + DAY_MS - now;
    const clears = [now];
    if (toAddress.length >= perAddress) clears.push(toAddress[toAddress.length - perAddress] + DAY_MS);
    if (toAddress.length > 0) clears.push(toAddress[toAddress.length - 1] + this.config.resend_interval_seconds * 1000);
    return Math.max(...clears) - now;
  }

  private linkUrl(token: string): string {
    return `${this.baseUrl}/v1/didit/${token}`;
  }

  private async save(session: SessionData): Promise<void> {
    await this.store.update(session.id, { challenges: session.challenges });
  }
}
