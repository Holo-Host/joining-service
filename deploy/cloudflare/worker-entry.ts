/**
 * Cloudflare Worker entry point for the joining service.
 *
 * Imports the Hono app and wires it up with Cloudflare-specific bindings
 * (KV for sessions, secrets for config).
 */

import { createApp, type ServiceContext } from '../../src/app.js';
import { resolveConfig, type ServiceConfig } from '../../src/config.js';
import { KvSessionStore } from '../../src/session/kv-store.js';
import { KvUrlProvider } from '../../src/urls/kv.js';
import { PostmarkTransport } from '../../src/email/postmark.js';
import { SendGridTransport } from '../../src/email/sendgrid.js';
import { HcAuthClient } from '../../src/hc-auth/index.js';
import type { MembraneProofGenerator } from '../../src/membrane-proof/generator.js';
import type { EmailTransport } from '../../src/email/transport.js';
import { buildAuthPlugins, flattenMethods } from '../../src/auth-plugins.js';
import { KvAllowedAgentStore } from '../../src/agent-registration/kv-store.js';
import { KvNetworkStore } from '../../src/network-registration/kv-store.js';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';

interface Env {
  SESSIONS: KVNamespace;
  CONFIG_JSON: string;
  SIGNING_KEY_HEX?: string;
}

function buildEmailTransport(config: ServiceConfig): EmailTransport | null {
  if (!config.email) return null;

  // FileTransport requires filesystem, so only API-based providers work on Workers
  if (config.email.provider === 'postmark') {
    if (!config.email.api_key || !config.email.from) {
      throw new Error('Postmark requires api_key and from');
    }
    return new PostmarkTransport(config.email.api_key, config.email.from);
  }

  if (config.email.provider === 'sendgrid') {
    if (!config.email.api_key || !config.email.from) {
      throw new Error('SendGrid requires api_key and from');
    }
    return new SendGridTransport(config.email.api_key, config.email.from);
  }

  return null;
}

async function buildProofGenerator(
  signingKeyHex?: string,
): Promise<MembraneProofGenerator | undefined> {
  if (!signingKeyHex) return undefined;
  // Dynamic import to avoid loading WASM (libsodium) in global scope,
  // which Cloudflare Workers disallows.
  const { LairProofGenerator } = await import(
    '../../src/membrane-proof/lair-signer.js'
  );
  return LairProofGenerator.fromHex(signingKeyHex);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const configInput = JSON.parse(env.CONFIG_JSON) as Partial<ServiceConfig>;

    // Override session store to cloudflare-kv (ignored by resolveConfig,
    // we construct the store directly)
    const config = resolveConfig(configInput);

    const sessionStore = new KvSessionStore(
      env.SESSIONS,
      config.session?.pending_ttl_seconds ?? 86400,
    );

    const hcAuthClient = config.hc_auth
      ? new HcAuthClient(config.hc_auth)
      : undefined;

    // Same gating as the Node entry point (src/server.ts): these stores back
    // the dynamic-registration admin surfaces, which are dead weight (and
    // cost nothing) when their auth method/admin_secret isn't configured.
    const enabledMethods = flattenMethods(config.auth_methods);

    const allowedAgentStore =
      enabledMethods.includes('agent_allow_list') || config.agent_registration
        ? new KvAllowedAgentStore(env.SESSIONS)
        : undefined;

    const networkStore = config.network_registration
      ? new KvNetworkStore(env.SESSIONS)
      : undefined;

    const linkerRegistrationStore = config.linker_auth?.admin_secret
      ? new LinkerRegistrationStore(env.SESSIONS)
      : undefined;

    // Merges dynamically registered linkers into URL provisioning alongside
    // the statically configured ones.
    const urlProvider = new KvUrlProvider(env.SESSIONS, linkerRegistrationStore);

    const emailTransport = buildEmailTransport(config);
    const authPlugins = buildAuthPlugins(config, { emailTransport, hcAuthClient, allowedAgentStore });

    let proofGenerator: MembraneProofGenerator | undefined;
    if (config.membrane_proof?.enabled) {
      proofGenerator = await buildProofGenerator(env.SIGNING_KEY_HEX);
    }

    const context: ServiceContext = {
      config,
      sessionStore,
      authPlugins,
      proofGenerator,
      urlProvider,
      hcAuthClient,
      allowedAgentStore,
      networkStore,
      linkerRegistrationStore,
    };

    const app = createApp(context);
    return app.fetch(request);
  },
};
