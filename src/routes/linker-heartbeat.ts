import { Hono } from 'hono';
import type { LinkerAuthConfig } from '../linker-auth/types.js';
import type { LinkerRegistrationStore } from '../linker-registration/store.js';
import type { RegisteredLinker } from '../linker-registration/types.js';
import { validateTimestamp, verifyHeartbeatSignature } from '../linker-registration/verify.js';
import { errorJson, safeParseJson } from './utils.js';
import { HeartbeatBody, DeregisterBody } from './request-types.js';

export function createLinkerRoutes(
  store: LinkerRegistrationStore,
  config: LinkerAuthConfig,
): Hono {
  const app = new Hono();
  const ttlSeconds = config.ttl_seconds ?? 600;
  const heartbeatInterval = config.heartbeat_interval_seconds ?? 200;
  const toleranceSeconds = config.timestamp_tolerance_seconds ?? 30;

  // ---- POST /v1/linkers/heartbeat ----
  app.post('/v1/linkers/heartbeat', async (c) => {
    const parsed = await safeParseJson(c.req.raw, HeartbeatBody);
    if ('error' in parsed) return parsed.error;
    const {
      pubkey, invite_token, linker_url, admin_url,
      admin_secret, rotate_secret, timestamp, signature,
    } = parsed.data;

    // Replay check: timestamp within tolerance
    const tsCheck = validateTimestamp(timestamp, toleranceSeconds);
    if (!tsCheck.valid) {
      return errorJson('invalid_timestamp', tsCheck.error!, 400);
    }

    // Look up existing registration
    const existing = await store.getLinker(pubkey);

    // Monotonic check for known pubkeys
    if (existing) {
      const monoCheck = validateTimestamp(timestamp, toleranceSeconds, existing.last_heartbeat);
      if (!monoCheck.valid) {
        return errorJson('invalid_timestamp', monoCheck.error!, 400);
      }
    }

    // Build signed fields (admin_secret included only when present)
    const fields: Record<string, string> = admin_secret
      ? { admin_secret, admin_url, linker_url, pubkey, timestamp }
      : { admin_url, linker_url, pubkey, timestamp };

    // Verify signature
    const sigValid = await verifyHeartbeatSignature({ pubkey, signature, fields });
    if (!sigValid) {
      return errorJson('invalid_signature', 'Signature verification failed', 401);
    }

    if (!existing) {
      // ---- First heartbeat ----
      if (!invite_token) {
        return errorJson('invalid_request', 'invite_token is required for first heartbeat', 400);
      }
      if (!admin_secret) {
        return errorJson('invalid_request', 'admin_secret is required for first heartbeat', 400);
      }

      const invite = await store.getInvite(invite_token);
      if (!invite) {
        return errorJson('invalid_invite', 'Invite token not found', 403);
      }

      // Check expiry
      if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
        return errorJson('invalid_invite', 'Invite has expired', 403);
      }

      // Check max_uses
      if (invite.max_uses != null && invite.used_by.length >= invite.max_uses) {
        return errorJson('invalid_invite', 'Invite has been fully used', 403);
      }

      // Create registered linker
      const linker: RegisteredLinker = {
        pubkey,
        invite_token,
        label: invite.label,
        capabilities: invite.capabilities,
        admin_secret,
        linker_url,
        admin_url,
        last_heartbeat: timestamp,
      };

      await store.putLinker(linker, ttlSeconds);

      // Update invite used_by
      invite.used_by.push(pubkey);
      await store.createInvite(invite);

      console.log('[linker-registration] new linker registered', {
        pubkey: pubkey.slice(0, 16) + '...',
        label: invite.label,
        linker_url,
      });

      return c.json({
        registered: true,
        ttl_seconds: ttlSeconds,
        heartbeat_interval_seconds: heartbeatInterval,
      }, 201);
    }

    // ---- Subsequent heartbeat ----
    existing.linker_url = linker_url;
    existing.admin_url = admin_url;
    existing.last_heartbeat = timestamp;

    if (admin_secret && rotate_secret) {
      existing.admin_secret = admin_secret;
    }

    await store.putLinker(existing, ttlSeconds);

    return c.json({
      registered: true,
      ttl_seconds: ttlSeconds,
      heartbeat_interval_seconds: heartbeatInterval,
    });
  });

  // ---- DELETE /v1/linkers/:pubkey ----
  app.delete('/v1/linkers/:pubkey', async (c) => {
    const pubkey = c.req.param('pubkey');
    const parsed = await safeParseJson(c.req.raw, DeregisterBody);
    if ('error' in parsed) return parsed.error;
    const { timestamp, signature } = parsed.data;

    const tsCheck = validateTimestamp(timestamp, toleranceSeconds);
    if (!tsCheck.valid) {
      return errorJson('invalid_timestamp', tsCheck.error!, 400);
    }

    const existing = await store.getLinker(pubkey);
    if (!existing) {
      return errorJson('not_found', 'Linker not found', 404);
    }

    // Monotonic check: prevent replay of captured deregistration requests
    const monoCheck = validateTimestamp(timestamp, toleranceSeconds, existing.last_heartbeat);
    if (!monoCheck.valid) {
      return errorJson('invalid_timestamp', monoCheck.error!, 400);
    }

    const sigValid = await verifyHeartbeatSignature({
      pubkey,
      signature,
      fields: { pubkey, timestamp },
    });
    if (!sigValid) {
      return errorJson('invalid_signature', 'Signature verification failed', 401);
    }

    await store.deleteLinker(pubkey);

    console.log('[linker-registration] linker deregistered', {
      pubkey: pubkey.slice(0, 16) + '...',
    });

    return new Response(null, { status: 204 });
  });

  return app;
}
