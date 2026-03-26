import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { resolveConfig, type ServiceConfig } from './config.js';
import { createApp, type ServiceContext } from './app.js';
import { MemorySessionStore } from './session/memory-store.js';
import { SqliteSessionStore } from './session/sqlite-store.js';
import type { SessionStore } from './session/store.js';
import { OpenAuthMethod } from './auth-methods/open.js';
import { EmailCodeAuthMethod } from './auth-methods/email-code.js';
import { InviteCodeAuthMethod } from './auth-methods/invite-code.js';
import { AgentAllowListAuthMethod } from './auth-methods/agent-allow-list.js';
import { HcAuthApprovalMethod } from './auth-methods/hc-auth-approval.js';
import { DelegatedVerificationAuthMethod } from './auth-methods/delegated-verification.js';
import { FileTransport } from './email/file.js';
import { PostmarkTransport } from './email/postmark.js';
import { SendGridTransport } from './email/sendgrid.js';
import { LairProofGenerator } from './membrane-proof/lair-signer.js';
import type { MembraneProofGenerator } from './membrane-proof/generator.js';
import type { AuthMethodPlugin } from './auth-methods/plugin.js';
import type { AuthMethod, AuthMethodEntry } from './types.js';
import type { EmailTransport } from './email/transport.js';
import { StaticUrlProvider } from './urls/static.js';
import type { UrlProvider } from './urls/provider.js';
import { HcAuthClient } from './hc-auth/index.js';

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

/** Flatten AuthMethodEntry[] into unique AuthMethod names for plugin init. */
function flattenMethods(entries: AuthMethodEntry[]): AuthMethod[] {
  const seen = new Set<AuthMethod>();
  for (const entry of entries) {
    if (typeof entry === 'object' && 'any_of' in entry) {
      for (const m of entry.any_of) seen.add(m);
    } else {
      seen.add(entry);
    }
  }
  return [...seen];
}

function buildAuthPlugins(
  config: ServiceConfig,
  emailTransport: EmailTransport | null,
  hcAuthClient?: HcAuthClient,
): Map<string, AuthMethodPlugin> {
  const plugins = new Map<string, AuthMethodPlugin>();

  for (const method of flattenMethods(config.auth_methods)) {
    switch (method) {
      case 'open':
        plugins.set('open', new OpenAuthMethod());
        break;

      case 'email_code':
        if (!emailTransport) {
          throw new Error(
            'email_code auth requires email config with a transport',
          );
        }
        plugins.set(
          'email_code',
          new EmailCodeAuthMethod({
            transport: emailTransport,
            subject: config.email?.template
              ? undefined
              : 'Your verification code',
            template: config.email?.template,
          }),
        );
        break;

      case 'invite_code':
        plugins.set(
          'invite_code',
          new InviteCodeAuthMethod(config.invite_codes ?? []),
        );
        break;

      case 'agent_allow_list':
        plugins.set(
          'agent_allow_list',
          new AgentAllowListAuthMethod(config.allowed_agents ?? []),
        );
        break;

      case 'hc_auth_approval':
        if (!hcAuthClient) {
          throw new Error(
            'hc_auth_approval auth method requires hc_auth config',
          );
        }
        plugins.set(
          'hc_auth_approval',
          new HcAuthApprovalMethod(hcAuthClient),
        );
        break;

      case 'delegated_verification':
        if (!config.delegated_verification) {
          throw new Error(
            'delegated_verification auth method requires delegated_verification config',
          );
        }
        plugins.set(
          'delegated_verification',
          new DelegatedVerificationAuthMethod(),
        );
        break;

      default:
        console.warn(`Unknown auth method: ${method}, skipping`);
    }
  }

  return plugins;
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

export async function startServer(
  configInput: Partial<ServiceConfig>,
  urlProvider?: UrlProvider,
): Promise<ReturnType<typeof serve>> {
  const config = resolveConfig(configInput);

  const sessionStore = buildSessionStore(config);

  const hcAuthClient = config.hc_auth
    ? new HcAuthClient(config.hc_auth)
    : undefined;

  const emailTransport = buildEmailTransport(config);
  const authPlugins = buildAuthPlugins(config, emailTransport, hcAuthClient);
  const proofGenerator = await buildProofGenerator(config);

  const resolvedUrlProvider = urlProvider ?? new StaticUrlProvider();

  const context: ServiceContext = {
    config,
    sessionStore,
    authPlugins,
    proofGenerator,
    urlProvider: resolvedUrlProvider,
    hcAuthClient,
  };

  const app = createApp(context);

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  console.log(`Joining service listening on port ${config.port}`);
  return server;
}

// CLI entry point
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
