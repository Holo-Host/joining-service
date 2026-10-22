import { Hono, type Context } from 'hono';
import type { SessionData, SessionStore } from '../session/store.js';
import type { DiditWithEmailAuthMethod } from '../auth-methods/didit-with-email.js';
import { TEXT, donePage, landingPage, messagePage, redirectTo } from '../auth-methods/didit-with-email-pages.js';
import { errorJson, safeParseJson } from './utils.js';
import { ResendBody } from './request-types.js';

export interface DiditRouteHooks {
  /** Runs the ready path once every requirement is met. Never throws: a failed step leaves the session pending. */
  finishJoin(session: SessionData): Promise<void>;
  pendingView(session: SessionData): object;
}

/** A link page's handler, answering any failure with a page rather than the API's JSON error. */
function page(handler: (c: Context) => Promise<Response>): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (err) {
      console.error('[didit_with_email] link page failed:', err);
      return messagePage(TEXT.unavailable, 503);
    }
  };
}

/** The emailed link's pages, and the resend of its email. */
export function createDiditRoutes(
  method: DiditWithEmailAuthMethod,
  store: SessionStore,
  hooks: DiditRouteHooks,
): Hono {
  const app = new Hono();

  // ---- GET /v1/didit/:token ----
  app.get('/v1/didit/:token', page(async (c) => {
    const found = await method.findLink(c.req.param('token'));
    if (!found) return messagePage(TEXT.invalid, 404);
    const { session, cs } = found;
    return landingPage({
      network: cs.link!.network_name,
      startedAt: session.created_at,
      agentKey: session.agent_key,
      state: cs.link!.state,
    });
  }));

  // ---- POST /v1/didit/:token ----
  app.post('/v1/didit/:token', page(async (c) => {
    const token = c.req.param('token');
    const found = await method.findLink(token);
    if (!found) return messagePage(TEXT.invalid, 404);
    const { session, cs } = found;

    const outcome = await method.continue(session, cs, token);
    switch (outcome.kind) {
      case 'redirect':
        return redirectTo(outcome.url);
      case 'approved':
        await hooks.finishJoin(session);
        return messagePage(TEXT.approved);
      case 'in_review':
        return messagePage(TEXT.inReview);
      case 'rejected':
        return messagePage(TEXT.rejected, 403);
      case 'unavailable':
        return messagePage(TEXT.unavailable, 503);
    }
  }));

  // ---- GET /v1/didit/:token/done ----
  app.get('/v1/didit/:token/done', page(async (c) => {
    const found = await method.findLink(c.req.param('token'));
    if (!found) return messagePage(TEXT.invalid, 404);
    const { session, cs } = found;
    await method.refresh(session);
    if (cs.completed) await hooks.finishJoin(session);
    return donePage(cs.link!.state);
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
