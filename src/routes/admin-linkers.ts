import { Hono } from 'hono';
import type { LinkerAuthConfig } from '../linker-auth/types.js';
import type { LinkerRegistrationStore } from '../linker-registration/store.js';
import { generateInviteToken } from '../linker-registration/types.js';
import type { LinkerInvite, RegisteredLinker } from '../linker-registration/types.js';
import { errorJson, safeEqual, safeParseJson } from './utils.js';
import { CreateInviteBody, UpdateLinkerBody } from './request-types.js';

/** Redact admin_secret from a RegisteredLinker for API responses. */
function redactLinker(linker: RegisteredLinker): Omit<RegisteredLinker, 'admin_secret'> & { admin_secret: string } {
  return { ...linker, admin_secret: '[redacted]' };
}

export function createAdminLinkerRoutes(
  store: LinkerRegistrationStore,
  config: LinkerAuthConfig,
): Hono {
  const app = new Hono();

  // Bearer token auth middleware (timing-safe comparison)
  app.use('/v1/admin/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth) {
      return errorJson('unauthorized', 'Authorization header required', 401);
    }
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!config.admin_secret || !safeEqual(token, config.admin_secret)) {
      return errorJson('forbidden', 'Invalid admin secret', 403);
    }
    await next();
  });

  // ---- POST /v1/admin/linker-invites ----
  app.post('/v1/admin/linker-invites', async (c) => {
    const parsed = await safeParseJson(c.req.raw, CreateInviteBody);
    if ('error' in parsed) return parsed.error;
    const { label, capabilities, max_uses, expires_at } = parsed.data;

    const token = generateInviteToken();
    const invite: LinkerInvite = {
      token,
      label,
      capabilities,
      max_uses,
      used_by: [],
      created_at: new Date().toISOString(),
      expires_at,
    };

    await store.createInvite(invite);
    return c.json({ invite_token: token }, 201);
  });

  // ---- GET /v1/admin/linker-invites ----
  app.get('/v1/admin/linker-invites', async (c) => {
    const invites = await store.listInvites();
    return c.json({ invites });
  });

  // ---- DELETE /v1/admin/linker-invites/:token ----
  app.delete('/v1/admin/linker-invites/:token', async (c) => {
    const token = c.req.param('token');
    const invite = await store.getInvite(token);
    if (!invite) {
      return errorJson('not_found', 'Invite not found', 404);
    }
    await store.deleteInvite(token);
    return new Response(null, { status: 204 });
  });

  // ---- GET /v1/admin/linkers ----
  app.get('/v1/admin/linkers', async (c) => {
    const linkers = await store.listLinkers();
    return c.json({ linkers: linkers.map(redactLinker) });
  });

  // ---- GET /v1/admin/linkers/:pubkey ----
  app.get('/v1/admin/linkers/:pubkey', async (c) => {
    const pubkey = c.req.param('pubkey');
    const linker = await store.getLinker(pubkey);
    if (!linker) {
      return errorJson('not_found', 'Linker not found', 404);
    }
    return c.json(redactLinker(linker));
  });

  // ---- PATCH /v1/admin/linkers/:pubkey ----
  app.patch('/v1/admin/linkers/:pubkey', async (c) => {
    const pubkey = c.req.param('pubkey');
    const linker = await store.getLinker(pubkey);
    if (!linker) {
      return errorJson('not_found', 'Linker not found', 404);
    }

    const parsed = await safeParseJson(c.req.raw, UpdateLinkerBody);
    if ('error' in parsed) return parsed.error;
    const { capabilities } = parsed.data;

    linker.capabilities = capabilities;

    // Re-write with remaining TTL (clamp to minimum 60s)
    const ttlSeconds = config.ttl_seconds ?? 600;
    const elapsed = (Date.now() - new Date(linker.last_heartbeat).getTime()) / 1000;
    const remaining = Math.max(60, Math.round(ttlSeconds - elapsed));
    await store.putLinker(linker, remaining);

    return c.json(redactLinker(linker));
  });

  // ---- DELETE /v1/admin/linkers/:pubkey ----
  app.delete('/v1/admin/linkers/:pubkey', async (c) => {
    const pubkey = c.req.param('pubkey');
    const linker = await store.getLinker(pubkey);
    if (!linker) {
      return errorJson('not_found', 'Linker not found', 404);
    }
    await store.deleteLinker(pubkey);
    return new Response(null, { status: 204 });
  });

  return app;
}
