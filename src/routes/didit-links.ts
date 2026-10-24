import { Hono } from 'hono';
import type { SessionData, SessionStore } from '../session/store.js';
import type { DiditWithEmailAuthMethod } from '../auth-methods/didit-with-email.js';
import { TEXT, linkPages, redirectTo } from '../auth-methods/didit-with-email-pages.js';
import { errorJson, safeParseJson } from './utils.js';
import { ResendBody } from './request-types.js';

export interface DiditRouteHooks {
  /** Runs the ready path once every requirement is met. Never throws: a failed step leaves the session pending. */
  finishJoin(session: SessionData): Promise<void>;
  pendingView(session: SessionData): object;
}

/** The emailed link's pages, and the resend of its email. */
export function createDiditRoutes(
  method: DiditWithEmailAuthMethod,
  store: SessionStore,
  hooks: DiditRouteHooks,
): Hono {
  const app = new Hono();
  const pages = linkPages(method.happName);

  /** A link page, answering any failure with a page rather than the API's JSON error. */
  async function page(render: () => Promise<Response>): Promise<Response> {
    try {
      return await render();
    } catch (err) {
      console.error('[didit_with_email] link page failed:', err);
      return pages.message(TEXT.unavailable, 503);
    }
  }

  // ---- GET /v1/didit/:token ----
  app.get('/v1/didit/:token', (c) => page(async () => {
    const found = await method.findLink(c.req.param('token'));
    if (!found) return pages.message(TEXT.invalid, 404);
    const { session, cs } = found;
    return pages.landing({
      network: cs.link!.network_name,
      startedAt: session.created_at,
      agentKey: session.agent_key,
      state: cs.link!.state,
    });
  }));

  // ---- POST /v1/didit/:token ----
  app.post('/v1/didit/:token', (c) => page(async () => {
    const found = await method.findLink(c.req.param('token'));
    if (!found) return pages.message(TEXT.invalid, 404);
    const { session, cs } = found;

    const outcome = await method.continue(session, cs);
    switch (outcome.kind) {
      case 'redirect':
        return redirectTo(outcome.url);
      case 'approved':
        await hooks.finishJoin(session);
        return pages.message(TEXT.approved);
      case 'in_review':
        return pages.message(TEXT.inReview);
      case 'rejected':
        return pages.message(TEXT.rejected, 403);
      case 'busy':
        return pages.message(TEXT.otherDevice, 409);
      case 'unavailable':
        return pages.message(TEXT.unavailable, 503);
    }
  }));

  // ---- GET /v1/didit/done/:credential ----
  app.get('/v1/didit/done/:credential', (c) => page(async () => {
    const found = await method.findDone(c.req.param('credential'));
    if (!found) return pages.message(TEXT.invalid, 404);
    const { session, cs } = found;
    if (session.status === 'rejected') return pages.message(session.reason ?? TEXT.rejected, 403);
    // Didit holds this credential, so the page's only write is a gated decision read. The app's next status call finishes the join.
    if (session.status === 'pending') await method.refresh(session);
    return pages.done(cs.link!.state);
  }));

  // ---- POST /v1/join/:session/resend ----
  app.post('/v1/join/:session/resend', async (c) => {
    const session = await store.get(c.req.param('session'));
    if (!session || session.status !== 'pending') {
      return errorJson('invalid_session', 'Session not found or not pending', 401);
    }
    const parsed = await safeParseJson(c.req.raw, ResendBody);
    if ('error' in parsed) return parsed.error;

    const cs = session.challenges.find(
      (x) => x.challenge.id === parsed.data.challenge_id && x.link && !x.completed,
    );
    if (!cs) {
      return errorJson('challenge_not_found', 'No open didit_with_email challenge with this id', 404);
    }

    await method.resend(session, cs);
    return c.json({ status: 'pending', ...hooks.pendingView(session) });
  });

  return app;
}
