import { vi } from 'vitest';
import { WORKFLOW_ID } from './fixtures.js';

const OPEN = new Set(['Not Started', 'In Progress', 'Resubmitted', 'Awaiting User']);

export interface FakeSession {
  session_id: string;
  status: string;
  vendor_data: string;
  workflow_id: string;
  environment: string;
  metadata: { agent_key?: string; email?: string } | null;
  url: string;
  session_token: string;
  created: number;
}

export interface FakeRequest {
  op: 'create' | 'decision' | 'list' | 'other';
  path: string;
  body?: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Didit's v3 session API as the service sees it, behind a `fetch` spy: one
 * open session per vendor_data, reused by create with its metadata
 * overwritten, decisions by id, and lists newest first.
 */
export class FakeDidit {
  sessions: FakeSession[] = [];
  requests: FakeRequest[] = [];
  down = false;
  private next = 1;

  install() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      this.respond(String(input), init ?? {}),
    );
  }

  calls(op: FakeRequest['op']): FakeRequest[] {
    return this.requests.filter((r) => r.op === op);
  }

  /** Adds a session as another join or another stack would have left it. */
  seed(fields: Partial<FakeSession> & { vendor_data: string }): FakeSession {
    const id = this.next++;
    const session: FakeSession = {
      session_id: `ds-${id}`,
      status: 'Not Started',
      workflow_id: WORKFLOW_ID,
      environment: 'sandbox',
      metadata: null,
      url: `https://verify.didit.me/session/SESSION-URL-${id}`,
      session_token: `SESSION-TOKEN-${id}`,
      created: id,
      ...fields,
    };
    this.sessions.push(session);
    return session;
  }

  respond(url: string, init: RequestInit): Response {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    const decisionId = /^\/v3\/session\/([^/]+)\/decision\/$/.exec(u.pathname)?.[1];
    const op: FakeRequest['op'] =
      method === 'POST' && u.pathname === '/v3/session/'
        ? 'create'
        : decisionId
          ? 'decision'
          : u.pathname === '/v3/sessions/'
            ? 'list'
            : 'other';
    this.requests.push({ op, path: u.pathname + u.search, body });
    if (this.down) return json({ detail: 'unavailable' }, 503);

    if (op === 'create') return this.create(body!);
    if (op === 'decision') return this.decision(decodeURIComponent(decisionId!));
    if (op === 'list') return this.list(u.searchParams);
    return json({ detail: 'Not found.' }, 404);
  }

  private create(body: Record<string, unknown>): Response {
    let session = this.sessions.find(
      (s) => s.vendor_data === body.vendor_data && s.workflow_id === body.workflow_id && OPEN.has(s.status),
    );
    if (session) {
      session.metadata = body.metadata as FakeSession['metadata'];
    } else {
      session = this.seed({
        vendor_data: body.vendor_data as string,
        workflow_id: body.workflow_id as string,
        metadata: body.metadata as FakeSession['metadata'],
      });
    }
    const { session_id, session_token, url, status } = session;
    return json({ session_id, session_token, url, status }, 201);
  }

  private decision(id: string): Response {
    const s = this.sessions.find((x) => x.session_id === id);
    if (!s) return json({ detail: 'Not found.' }, 404);
    return json({
      session_id: s.session_id,
      status: s.status,
      workflow_id: s.workflow_id,
      vendor_data: s.vendor_data,
      environment: s.environment,
      metadata: s.metadata,
      session_url: s.url,
      id_verifications: [{ full_name: 'Ada Lovelace', date_of_birth: '1815-12-10' }],
    });
  }

  private list(params: URLSearchParams): Response {
    const rows = this.sessions
      .filter((s) => s.vendor_data === params.get('vendor_data') && s.workflow_id === params.get('workflow_id'))
      .sort((a, b) => b.created - a.created);
    return json({
      count: rows.length,
      results: rows.map((s) => ({ session_id: s.session_id, status: s.status, full_name: 'Ada Lovelace' })),
    });
  }
}
