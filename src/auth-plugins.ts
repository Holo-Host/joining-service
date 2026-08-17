import type { ServiceConfig } from './config.js';
import type { AuthMethod, AuthMethodEntry } from './types.js';
import type { AuthMethodPlugin } from './auth-methods/plugin.js';
import type { EmailTransport } from './email/transport.js';
import type { HcAuthClient } from './hc-auth/index.js';
import type { AllowedAgentStore } from './agent-registration/store.js';
import { OpenAuthMethod } from './auth-methods/open.js';
import { EmailCodeAuthMethod } from './auth-methods/email-code.js';
import { InviteCodeAuthMethod } from './auth-methods/invite-code.js';
import { AgentAllowListAuthMethod } from './auth-methods/agent-allow-list.js';
import { HcAuthApprovalMethod } from './auth-methods/hc-auth-approval.js';
import { DelegatedVerificationAuthMethod } from './auth-methods/delegated-verification.js';

/** Flatten AuthMethodEntry[] into unique AuthMethod names for plugin init. */
export function flattenMethods(entries: AuthMethodEntry[]): AuthMethod[] {
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

export interface AuthPluginDeps {
  emailTransport?: EmailTransport | null;
  hcAuthClient?: HcAuthClient;
  allowedAgentStore?: AllowedAgentStore;
}

/**
 * Build the auth-method plugin map. Every entry point (Node server,
 * Cloudflare Worker) builds its plugins through this one function, so they
 * cannot drift from each other.
 */
export function buildAuthPlugins(
  config: ServiceConfig,
  deps: AuthPluginDeps = {},
): Map<string, AuthMethodPlugin> {
  const { emailTransport = null, hcAuthClient, allowedAgentStore } = deps;
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
          new AgentAllowListAuthMethod(config.allowed_agents ?? [], allowedAgentStore),
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

      // sms_code, evm_signature, and solana_signature have no server-side
      // AuthMethodPlugin implementation yet (they're client-side UI form
      // hints only, see src/ui/) -- warn and skip, same as an unrecognized
      // method. Each needs its own case (rather than falling into `default`
      // together with it) so the exhaustiveness guard below narrows
      // correctly -- see that comment.
      case 'sms_code':
      case 'evm_signature':
      case 'solana_signature':
        console.warn(`Unknown auth method: ${method}, skipping`);
        break;

      default: {
        // Exhaustiveness guard: with every concrete AuthMethod given its own
        // case above, TypeScript narrows `method` here to exactly the
        // custom `x-${string}` template member. Adding a new AuthMethod to
        // the union in src/types.ts without a case for it above makes this
        // assignment fail to compile, catching the drift that previously
        // let the Worker's plugin switch silently skip whole auth methods.
        const _customOnly: `x-${string}` = method;
        console.warn(`Unknown auth method: ${_customOnly}, skipping`);
      }
    }
  }

  return plugins;
}
