import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { NetworkStore } from '../network-registration/store.js';
import { isValidDnaHash } from '../config.js';
import { validateAgentKey } from '../utils.js';
import { errorJson, safeEqual, safeParseJson } from './utils.js';
import { RegisterNetworkBody } from './request-types.js';

// Shared with the join handler (src/app.ts), which applies the same format
// check before a store lookup so malformed happ ids are rejected as cheaply
// as unregistered ones. Real happ ids may contain dots (e.g. reverse-DNS
// style ids), so the charset is wider than a typical slug.
export const HAPP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AdminNetworkRoutesOptions {
  adminSecret: string;
  requireDnaHash: boolean;
  staticHappId: string;
}

export function createAdminNetworkRoutes(
  store: NetworkStore,
  options: AdminNetworkRoutesOptions,
): Hono {
  const { adminSecret, requireDnaHash, staticHappId } = options;
  const app = new Hono();

  // Bearer token auth middleware (timing-safe comparison). Scoped to the
  // network-registration path family only -- Hono flattens routes+middleware
  // from `app.route('', subApp)`, so a broader `/v1/admin/*` match here would
  // also gate the other admin sub-apps (and vice versa) when multiple are
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
  app.use('/v1/admin/networks', requireAdminSecret);
  app.use('/v1/admin/networks/*', requireAdminSecret);

  // ---- POST /v1/admin/networks ----
  app.post('/v1/admin/networks', async (c) => {
    const parsed = await safeParseJson(c.req.raw, RegisterNetworkBody);
    if ('error' in parsed) return parsed.error;
    const { happ_id, happ, roles, allowed_agents } = parsed.data;

    if (!HAPP_ID_RE.test(happ_id)) {
      return errorJson(
        'invalid_happ_id',
        'happ_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/',
        400,
      );
    }

    // A registered network sharing the service's own static happ id would
    // collide with the statically configured network (see the join
    // normalization in src/app.ts), silently taking over its session scope.
    if (happ_id === staticHappId) {
      return errorJson(
        'invalid_happ_id',
        "happ_id conflicts with the service's static happ id",
        400,
      );
    }

    const roleEntries = Object.entries(roles);
    if (roleEntries.length === 0) {
      return errorJson('invalid_role_config', 'roles must not be empty', 400);
    }
    for (const [role, rc] of roleEntries) {
      if (rc.dna_hash !== undefined && !isValidDnaHash(rc.dna_hash)) {
        return errorJson(
          'invalid_role_config',
          `roles.${role}.dna_hash is not a valid DnaHash`,
          400,
        );
      }
      if (requireDnaHash && !rc.dna_hash) {
        return errorJson(
          'invalid_role_config',
          `roles.${role}.dna_hash is required when membrane proofs are enabled`,
          400,
        );
      }
    }

    for (const agentKey of allowed_agents ?? []) {
      const validation = validateAgentKey(agentKey);
      if (!validation.valid) {
        return errorJson('invalid_agent_key', validation.reason!, 400);
      }
    }

    const network = {
      happ_id,
      happ,
      roles,
      allowed_agents,
      registered_at: new Date().toISOString(),
    };
    await store.put(network);
    return c.json(network, 201);
  });

  // ---- GET /v1/admin/networks ----
  app.get('/v1/admin/networks', async (c) => {
    return c.json({ networks: await store.list() });
  });

  // ---- GET /v1/admin/networks/:happ_id ----
  app.get('/v1/admin/networks/:happ_id', async (c) => {
    // Hono already decodes path params, so no further decoding is needed.
    const happId = c.req.param('happ_id');
    const network = await store.get(happId);
    if (!network) {
      return errorJson('not_found', 'Network not registered', 404);
    }
    return c.json(network);
  });

  // ---- DELETE /v1/admin/networks/:happ_id ----
  app.delete('/v1/admin/networks/:happ_id', async (c) => {
    const happId = c.req.param('happ_id');
    if (!(await store.get(happId))) {
      return errorJson('not_found', 'Network not registered', 404);
    }
    await store.delete(happId);
    return new Response(null, { status: 204 });
  });

  return app;
}
