// Public API exports
export { createApp, type ServiceContext } from './app.js';
export { resolveConfig, type ServiceConfig } from './config.js';
export { startServer } from './server.js';

// URL providers
export type { UrlProvider } from './urls/provider.js';
export { StaticUrlProvider } from './urls/static.js';
export { KvUrlProvider, type KVNamespace as UrlKVNamespace } from './urls/kv.js';

// Session
export type { SessionStore, SessionData, ChallengeState } from './session/store.js';
export { MemorySessionStore } from './session/memory-store.js';
export { SqliteSessionStore } from './session/sqlite-store.js';
export { KvSessionStore } from './session/kv-store.js';

// Auth plugins
export type { AuthMethodPlugin } from './auth-methods/plugin.js';
export { OpenAuthMethod } from './auth-methods/open.js';
export { EmailCodeAuthMethod } from './auth-methods/email-code.js';
export { InviteCodeAuthMethod } from './auth-methods/invite-code.js';
export { DelegatedVerificationAuthMethod, validateDelegatedVerification, resetRateLimitState } from './auth-methods/delegated-verification.js';
export type { TrustedPartner, DelegatedVerificationConfig, DelegatedVerificationPayload } from './auth-methods/delegated-verification.js';

// Email transports
export type { EmailTransport } from './email/transport.js';
export { FileTransport } from './email/file.js';
export { PostmarkTransport } from './email/postmark.js';

// Linker auth
export { LinkerAuthClient } from './linker-auth/index.js';
export type { LinkerAdminInfo, LinkerRegistration, LinkerAuthConfig, LinkerCapability } from './linker-auth/index.js';

// Dynamic linker registration
export type { LinkerInvite, RegisteredLinker } from './linker-registration/index.js';
export { LinkerRegistrationStore } from './linker-registration/index.js';
export { toLinkerRegistration, generateInviteToken, canonicalJson, verifyHeartbeatSignature, validateTimestamp } from './linker-registration/index.js';

// Dynamic agent registration
export type { AllowedAgentStore, RegisteredAgent } from './agent-registration/index.js';
export { MemoryAllowedAgentStore, SqliteAllowedAgentStore, KvAllowedAgentStore } from './agent-registration/index.js';

// Membrane proof
export type { MembraneProofGenerator } from './membrane-proof/generator.js';
export { LairProofGenerator } from './membrane-proof/lair-signer.js';

// Types
export * from './types.js';

// Utilities
export { validateAgentKey, generateSessionId, toBase64, fromBase64, decodeHashFromBase64, encodeHashToBase64, agentPubKeyFrom32, dhtLocationFrom32 } from './utils.js';

// Client library (also available as '@holo-host/joining-service/client')
export {
  JoiningClient,
  JoinSession,
  JoiningError,
  GatewayProxy,
  GatewayError,
} from './client/index.js';
export type { GatewayCallZomeParams } from './client/index.js';
