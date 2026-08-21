import { createApp, type ServiceContext } from '../src/app.js';
import { resolveConfig, type ServiceConfig } from '../src/config.js';
import { MemorySessionStore } from '../src/session/memory-store.js';
import { SqliteSessionStore } from '../src/session/sqlite-store.js';
import type { SessionStore } from '../src/session/store.js';
import { OpenAuthMethod } from '../src/auth-methods/open.js';
import { EmailCodeAuthMethod } from '../src/auth-methods/email-code.js';
import { InviteCodeAuthMethod } from '../src/auth-methods/invite-code.js';
import { AgentAllowListAuthMethod } from '../src/auth-methods/agent-allow-list.js';
import { HcAuthApprovalMethod } from '../src/auth-methods/hc-auth-approval.js';
import { DelegatedVerificationAuthMethod } from '../src/auth-methods/delegated-verification.js';
import { FileTransport } from '../src/email/file.js';
import { randomBytes } from 'node:crypto';
import { LairProofGenerator } from '../src/membrane-proof/lair-signer.js';
import { StaticUrlProvider } from '../src/urls/static.js';
import type { UrlProvider } from '../src/urls/provider.js';
import type { AuthMethodPlugin } from '../src/auth-methods/plugin.js';
import type { HcAuthClient } from '../src/hc-auth/index.js';
import type { AuthMethod, AuthMethodEntry } from '../src/types.js';
import type { Hono } from 'hono';
import { encodeHashToBase64, dhtLocationFrom32 } from '../src/utils.js';
import { MemoryAllowedAgentStore } from '../src/agent-registration/memory-store.js';
import type { AllowedAgentStore } from '../src/agent-registration/store.js';
import { LinkerRegistrationStore } from '../src/linker-registration/store.js';
import { createMockKV } from './linker-registration/helpers.js';

/**
 * Generate a fake AgentPubKey in HoloHash base64 format ("u" + base64url).
 * Computes a valid DHT location so the hash is well-formed.
 */
export function fakeAgentKey(seed = 0): string {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (seed + i + 3) & 0xff;
  }
  const loc = dhtLocationFrom32(core);
  const bytes = new Uint8Array(39);
  bytes[0] = 0x84;
  bytes[1] = 0x20;
  bytes[2] = 0x24;
  bytes.set(core, 3);
  bytes.set(loc, 35);
  return encodeHashToBase64(bytes);
}

/** Generate a fake DnaHash in HoloHash base64 format ("u" + base64url). */
export function fakeDnaHash(seed = 0): string {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (seed + i + 7) & 0xff;
  }
  const loc = dhtLocationFrom32(core);
  const bytes = new Uint8Array(39);
  // DnaHash prefix: 0x84, 0x2d, 0x24
  bytes[0] = 0x84;
  bytes[1] = 0x2d;
  bytes[2] = 0x24;
  bytes.set(core, 3);
  bytes.set(loc, 35);
  return encodeHashToBase64(bytes);
}

export interface TestApp {
  app: Hono;
  ctx: ServiceContext;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

export async function createTestApp(
  configOverrides: Partial<ServiceConfig> = {},
  pluginOverrides?: Map<string, AuthMethodPlugin>,
  urlProvider?: UrlProvider,
  hcAuthClient?: HcAuthClient,
): Promise<TestApp> {
  const defaults: Partial<ServiceConfig> = {
    happ: {
      id: 'test-app',
      name: 'Test App',
      happ_bundle_url: 'https://example.com/test.happ',
    },
    auth_methods: ['open'],
    session: { store: 'memory', pending_ttl_seconds: 86400 },
  };

  const merged = { ...defaults, ...configOverrides };
  // Merge happ fields
  if (configOverrides.happ) {
    merged.happ = { ...defaults.happ, ...configOverrides.happ };
  }

  const config = resolveConfig(merged);

  let sessionStore: SessionStore;
  if (config.session!.store === 'sqlite') {
    sessionStore = new SqliteSessionStore(
      config.session!.db_path ?? ':memory:',
      config.session!.pending_ttl_seconds,
    );
  } else {
    sessionStore = new MemorySessionStore(
      config.session!.pending_ttl_seconds,
    );
  }

  // Flatten AuthMethodEntry[] to unique method names for plugin init
  const methods = new Set<AuthMethod>();
  for (const entry of config.auth_methods) {
    if (typeof entry === 'object' && 'any_of' in entry) {
      for (const m of (entry as { any_of: AuthMethod[] }).any_of) methods.add(m);
    } else {
      methods.add(entry as AuthMethod);
    }
  }

  const allowedAgentStore: AllowedAgentStore | undefined =
    config.agent_registration || methods.has('agent_allow_list')
      ? new MemoryAllowedAgentStore()
      : undefined;

  const linkerRegistrationStore: LinkerRegistrationStore | undefined =
    config.linker_auth?.admin_secret
      ? new LinkerRegistrationStore(createMockKV())
      : undefined;

  let authPlugins: Map<string, AuthMethodPlugin>;
  if (pluginOverrides) {
    authPlugins = pluginOverrides;
  } else {
    authPlugins = new Map();
    for (const method of methods) {
      switch (method) {
        case 'open':
          authPlugins.set('open', new OpenAuthMethod());
          break;
        case 'email_code': {
          const transport = new FileTransport(
            config.email?.output_dir ?? '/tmp/test-emails',
          );
          authPlugins.set(
            'email_code',
            new EmailCodeAuthMethod({ transport }),
          );
          break;
        }
        case 'invite_code':
          authPlugins.set(
            'invite_code',
            new InviteCodeAuthMethod(config.invite_codes ?? []),
          );
          break;
        case 'agent_allow_list':
          authPlugins.set(
            'agent_allow_list',
            new AgentAllowListAuthMethod(config.allowed_agents ?? [], allowedAgentStore),
          );
          break;
        case 'hc_auth_approval':
          if (hcAuthClient) {
            authPlugins.set(
              'hc_auth_approval',
              new HcAuthApprovalMethod(hcAuthClient),
            );
          }
          break;
        case 'delegated_verification':
          authPlugins.set(
            'delegated_verification',
            new DelegatedVerificationAuthMethod(),
          );
          break;
      }
    }
  }

  let proofGenerator: LairProofGenerator | undefined;
  if (config.membrane_proof?.enabled) {
    proofGenerator = await LairProofGenerator.fromSeed(randomBytes(32));
  }

  const resolvedUrlProvider = urlProvider ?? new StaticUrlProvider(['wss://linker.example.com:8090']);

  const ctx: ServiceContext = {
    config,
    sessionStore,
    authPlugins,
    proofGenerator,
    urlProvider: resolvedUrlProvider,
    hcAuthClient,
    allowedAgentStore,
    linkerRegistrationStore,
  };

  const app = createApp(ctx);

  const request = (path: string, init?: RequestInit) =>
    app.request(path, init);

  return { app, ctx, request };
}
