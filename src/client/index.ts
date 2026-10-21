// Client classes
export { JoiningClient, JoinSession, JoiningError, type SignTimestamp } from './joining.js';
export { GatewayProxy, GatewayError, type GatewayCallZomeParams } from './gateway-proxy.js';

// Re-export shared API types that client consumers need
export type {
  WellKnownHoloJoining,
  JoiningServiceInfo,
  HttpGateway,
  LinkerUrl,
  AuthMethod,
  AuthMethodEntry,
  DnaModifiers,
  Challenge,
  JoinProvision,
  ReconnectRequest,
  ReconnectResponse,
  ResumeRequest,
  ResumeResponse,
  ResendRequest,
  DiditWithEmailState,
  DiditWithEmailMetadata,
} from '../types.js';
