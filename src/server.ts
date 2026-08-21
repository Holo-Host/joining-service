import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { resolveConfig, type ServiceConfig } from './config.js';
import { createApp, type ServiceContext } from './app.js';
import { MemorySessionStore } from './session/memory-store.js';
import { SqliteSessionStore } from './session/sqlite-store.js';
import type { SessionStore } from './session/store.js';
import { FileTransport } from './email/file.js';
import { PostmarkTransport } from './email/postmark.js';
import { SendGridTransport } from './email/sendgrid.js';
import { LairProofGenerator } from './membrane-proof/lair-signer.js';
import type { MembraneProofGenerator } from './membrane-proof/generator.js';
import type { EmailTransport } from './email/transport.js';
import { buildAuthPlugins, flattenMethods } from './auth-plugins.js';
import { StaticUrlProvider } from './urls/static.js';
import type { UrlProvider } from './urls/provider.js';
import { HcAuthClient } from './hc-auth/index.js';
import { MemoryAllowedAgentStore } from './agent-registration/memory-store.js';
import { SqliteAllowedAgentStore } from './agent-registration/sqlite-store.js';
import type { AllowedAgentStore } from './agent-registration/store.js';
import { MemoryNetworkStore } from './network-registration/memory-store.js';
import { SqliteNetworkStore } from './network-registration/sqlite-store.js';
import type { NetworkStore } from './network-registration/store.js';

function buildEmailTransport(config: ServiceConfig): EmailTransport | null {
  if (!config.email) return null;

  if (config.email.provider === 'file') {
    return new FileTransport(config.email.output_dir ?? './dev-emails');
  }

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
  config: ServiceConfig,
): Promise<MembraneProofGenerator | undefined> {
  if (!config.membrane_proof?.enabled) return undefined;

  if (config.membrane_proof.signing_key_path) {
    const keyHex = readFileSync(
      config.membrane_proof.signing_key_path,
      'utf-8',
    ).trim();
    return LairProofGenerator.fromHex(keyHex);
  }

  // Generate ephemeral key for dev
  const { randomBytes } = await import('node:crypto');
  return LairProofGenerator.fromSeed(randomBytes(32));
}

function buildSessionStore(config: ServiceConfig): SessionStore {
  const pendingTtl = config.session!.pending_ttl_seconds;

  if (config.session!.store === 'sqlite') {
    const dbPath = config.session!.db_path ?? './sessions.db';
    return new SqliteSessionStore(dbPath, pendingTtl);
  }

  return new MemorySessionStore(pendingTtl);
}

/**
 * Store for runtime-registered allowed agents. Constructed whenever the
 * agent_allow_list auth method or agent_registration admin API is in play
 * (a memory store costs nothing when unused). Backend mirrors session.store:
 * sqlite deployments get a sibling `allowed-agents.db` next to the sessions db.
 */
export function buildAllowedAgentStore(config: ServiceConfig): AllowedAgentStore {
  if (config.session!.store === 'sqlite') {
    const dbPath = config.session!.db_path ?? './sessions.db';
    // ':memory:' has no sibling directory to derive a shared path from --
    // an in-memory sessions db implies an in-memory agents store too.
    if (dbPath === ':memory:') {
      return new MemoryAllowedAgentStore();
    }
    const agentsDbPath = join(dirname(dbPath), 'allowed-agents.db');
    return new SqliteAllowedAgentStore(agentsDbPath);
  }

  return new MemoryAllowedAgentStore();
}

/**
 * Store for runtime-registered networks (multi-network admin API). Backend
 * mirrors session.store, same as buildAllowedAgentStore: sqlite deployments
 * get a sibling `networks.db` next to the sessions db. Workers construct
 * `KvNetworkStore` themselves.
 */
export function buildNetworkStore(config: ServiceConfig): NetworkStore {
  if (config.session!.store === 'sqlite') {
    const dbPath = config.session!.db_path ?? './sessions.db';
    // ':memory:' has no sibling directory to derive a shared path from --
    // an in-memory sessions db implies an in-memory network store too.
    if (dbPath === ':memory:') {
      return new MemoryNetworkStore();
    }
    const networksDbPath = join(dirname(dbPath), 'networks.db');
    return new SqliteNetworkStore(networksDbPath);
  }

  return new MemoryNetworkStore();
}

export async function startServer(
  configInput: Partial<ServiceConfig>,
  urlProvider?: UrlProvider,
): Promise<ReturnType<typeof serve>> {
  const config = resolveConfig(configInput);

  const sessionStore = buildSessionStore(config);

  const hcAuthClient = config.hc_auth
    ? new HcAuthClient(config.hc_auth)
    : undefined;

  const enabledMethods = flattenMethods(config.auth_methods);

  if (config.agent_registration && !enabledMethods.includes('agent_allow_list')) {
    console.warn(
      '[agent_registration] admin_secret is configured but "agent_allow_list" is not in auth_methods; ' +
        'registrations via /v1/admin/allowed-agents will have no effect on joins until it is added.',
    );
  }

  const allowedAgentStore =
    enabledMethods.includes('agent_allow_list') || config.agent_registration
      ? buildAllowedAgentStore(config)
      : undefined;

  const networkStore = config.network_registration
    ? buildNetworkStore(config)
    : undefined;

  if (networkStore) {
    // Fire-and-forget: a network registered under the service's own static
    // happ id is shadowed by the join/info normalization rule (see app.ts)
    // and can never be reached as a distinct network -- warn operators
    // without blocking startup on the store round-trip.
    networkStore.get(config.happ.id).then((record) => {
      if (record) {
        console.warn(
          `[network_registration] a network is registered under happ_id "${config.happ.id}", ` +
            "which is this service's own static happ id -- it is shadowed by the static " +
            'network and unreachable via POST /v1/join or GET /v1/info/:happ_id.',
        );
      }
    }).catch((err) => {
      console.error('[network_registration] startup shadow check failed (non-fatal):', err);
    });
  }

  const emailTransport = buildEmailTransport(config);
  const authPlugins = buildAuthPlugins(config, { emailTransport, hcAuthClient, allowedAgentStore });
  const proofGenerator = await buildProofGenerator(config);

  const resolvedUrlProvider = urlProvider ?? new StaticUrlProvider();

  const context: ServiceContext = {
    config,
    sessionStore,
    authPlugins,
    proofGenerator,
    urlProvider: resolvedUrlProvider,
    hcAuthClient,
    allowedAgentStore,
    networkStore,
  };

  const app = createApp(context);

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Joining service listening on port ${config.port}`);
  return server;
}

// CLI entry point. Guarded so this module can be imported (e.g. by tests
// exercising buildAllowedAgentStore) without launching a server or exiting
// the process as a side effect of import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2] ?? './config.json';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const { linker_registrations, http_gateways, ...configInput } = JSON.parse(raw);
    const urlProvider = new StaticUrlProvider(linker_registrations, http_gateways);
    startServer(configInput, urlProvider);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Failed to start: ${message}`);
    process.exit(1);
  }
}
