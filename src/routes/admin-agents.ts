import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AllowedAgentStore } from '../agent-registration/store.js';
import { validateAgentKey } from '../utils.js';
import { errorJson, safeEqual, safeParseJson } from './utils.js';
import { RegisterAgentBody } from './request-types.js';

export function createAdminAgentRoutes(
  store: AllowedAgentStore,
  adminSecret: string,
): Hono {
  const app = new Hono();

  // Bearer token auth middleware (timing-safe comparison). Scoped to the
  // allowed-agents path family only -- Hono flattens routes+middleware from
  // `app.route('', subApp)`, so a broader `/v1/admin/*` match here would also
  // gate the linker admin sub-app's routes (and vice versa) when both are
  // mounted with different secrets.
  const requireAdminSecret: MiddlewareHandler = async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth) {
      return errorJson('unauthorized', 'Authorization header required', 401);
    }
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!adminSecret || !safeEqual(token, adminSecret)) {
      return errorJson('forbidden', 'Invalid admin secret', 403);
    }
    await next();
  };
  app.use('/v1/admin/allowed-agents', requireAdminSecret);
  app.use('/v1/admin/allowed-agents/*', requireAdminSecret);

  // ---- POST /v1/admin/allowed-agents ----
  app.post('/v1/admin/allowed-agents', async (c) => {
    const parsed = await safeParseJson(c.req.raw, RegisterAgentBody);
    if ('error' in parsed) return parsed.error;
    const { agent_key, label } = parsed.data;

    const validation = validateAgentKey(agent_key);
    if (!validation.valid) {
      return errorJson('invalid_agent_key', validation.reason!, 400);
    }

    const agent = { agent_key, label, registered_at: new Date().toISOString() };
    await store.put(agent);
    return c.json(agent, 201);
  });

  // ---- GET /v1/admin/allowed-agents ----
  app.get('/v1/admin/allowed-agents', async (c) => {
    return c.json({ agents: await store.list() });
  });

  // ---- DELETE /v1/admin/allowed-agents/:agent_key ----
  app.delete('/v1/admin/allowed-agents/:agent_key', async (c) => {
    // Hono already decodes path params; base64url agent keys are URI-safe,
    // so no further decoding is needed (and a raw `%` here would throw).
    const agentKey = c.req.param('agent_key');
    if (!(await store.has(agentKey))) {
      return errorJson('not_found', 'Agent not registered', 404);
    }
    await store.delete(agentKey);
    return new Response(null, { status: 204 });
  });

  return app;
}
