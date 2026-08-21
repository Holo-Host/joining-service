import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { JoiningClient, JoinSession, JoiningError } from '../client/joining.js';
import type { AuthMethodEntry, Challenge, JoinProvision } from '../types.js';
import type { JoiningStatusValue } from './joining-status.js';
import type { ClaimsSubmittedDetail } from './joining-claims-form.js';
import type { ChallengeResponseDetail } from './joining-challenge-dialog.js';

// Side-effect imports to register custom elements
import './joining-claims-form.js';
import './joining-challenge-dialog.js';
import './joining-status.js';

/** Methods handled automatically without user interaction. */
const AUTO_METHODS = new Set(['open', 'agent_allow_list']);

/** Default maximum number of poll iterations before timing out. */
const DEFAULT_MAX_POLL_ATTEMPTS = 30;

export interface JoinCompleteDetail {
  provision: JoinProvision;
  claims: Record<string, string>;
}

export interface JoinErrorDetail {
  error: Error;
}

/**
 * Orchestrator component that manages the full joining flow:
 * 1. Fetches service info to discover auth methods
 * 2. Shows claims form if interactive methods are required
 * 3. Initiates join session
 * 4. Handles challenges (interactive or automatic)
 * 5. Retrieves provision on success
 *
 * Headless: renders child components with no styling.
 * Extend this class and override render() for styled variants.
 */
@customElement('joining-flow')
export class JoiningFlow extends LitElement {
  /** URL of the joining service. Mutually exclusive with joiningClient. */
  @property({ attribute: 'service-url' })
  serviceUrl?: string;

  /** Pre-constructed JoiningClient instance. Mutually exclusive with serviceUrl. */
  @property({ attribute: false })
  joiningClient?: JoiningClient;

  /** Base64-encoded 39-byte AgentPubKey. */
  @property({ attribute: 'agent-key' })
  agentKey?: string;

  /**
   * Callback to sign a nonce for agent_allow_list challenges.
   * Receives the raw nonce bytes, must return the ed25519 signature bytes.
   */
  @property({ attribute: false })
  signNonce?: (nonce: Uint8Array) => Promise<Uint8Array>;

  /** Pre-filled claims. If provided, skips the claims form for matching methods. */
  @property({ attribute: false })
  claims?: Record<string, string>;

  /** Maximum poll attempts before timing out. */
  @property({ type: Number, attribute: 'max-poll-attempts' })
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS;

  @state()
  protected flowStatus: JoiningStatusValue = 'idle';

  @state()
  protected statusReason?: string;

  @state()
  protected authMethods: AuthMethodEntry[] = [];

  @state()
  protected currentChallenge: Challenge | null = null;

  @state()
  protected collectedClaims: Record<string, string> = {};

  @state()
  protected pendingChallengeResolve: ((response: string) => void) | null = null;

  /** Disable shadow DOM for external styling. Subclasses may re-enable. */
  protected override createRenderRoot(): HTMLElement | ShadowRoot {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.serviceUrl || this.joiningClient) {
      this.start();
    }
  }

  /** Start or restart the joining flow. */
  async start() {
    try {
      this.flowStatus = 'connecting';
      this.statusReason = undefined;

      const client = this.getClient();
      const info = await client.getInfo();
      this.authMethods = info.auth_methods;

      // Check if all methods are automatic (no UI needed)
      const needsClaims = this.needsInteractiveClaims(info.auth_methods);

      if (needsClaims && !this.hasPrefilledClaims(info.auth_methods)) {
        this.flowStatus = 'collecting-claims';
        // Wait for claims-submitted event (handled in handleClaimsSubmitted)
        return;
      }

      // Use pre-filled claims or empty
      this.collectedClaims = this.claims ?? {};
      await this.executeJoin(client);
    } catch (e) {
      this.handleError(e);
    }
  }

  protected getClient(): JoiningClient {
    if (this.joiningClient) return this.joiningClient;
    if (this.serviceUrl) return JoiningClient.fromUrl(this.serviceUrl);
    throw new Error('Either service-url or joiningClient must be provided');
  }

  private needsInteractiveClaims(methods: AuthMethodEntry[]): boolean {
    for (const entry of methods) {
      if (typeof entry === 'string') {
        if (!AUTO_METHODS.has(entry)) return true;
      } else if ('any_of' in entry) {
        const hasInteractive = entry.any_of.some((m) => !AUTO_METHODS.has(m));
        if (hasInteractive) return true;
      }
    }
    return false;
  }

  private hasPrefilledClaims(methods: AuthMethodEntry[]): boolean {
    if (!this.claims || Object.keys(this.claims).length === 0) return false;
    for (const entry of methods) {
      if (typeof entry === 'string') {
        if (!AUTO_METHODS.has(entry) && !this.claims[entry]) return false;
      } else if ('any_of' in entry) {
        const satisfied = entry.any_of.some(
          (m) => AUTO_METHODS.has(m) || (this.claims && this.claims[m]),
        );
        if (!satisfied) return false;
      }
    }
    return true;
  }

  protected async executeJoin(client: JoiningClient) {
    if (!this.agentKey) {
      throw new Error('agent-key must be provided');
    }

    this.flowStatus = 'joining';
    let session = await client.join(this.agentKey, this.collectedClaims);

    const satisfiedGroups = new Set<string>();
    let pollCount = 0;

    while (session.status === 'pending') {
      this.flowStatus = 'verifying';

      if (!session.challenges || session.challenges.length === 0) {
        if (++pollCount > this.maxPollAttempts) {
          throw new Error('Verification timed out. Please try again.');
        }
        await delay(session.pollIntervalMs ?? 2000);
        session = await session.pollStatus();
        continue;
      }

      let madeProgress = false;

      for (const challenge of session.challenges) {
        if (challenge.completed) continue;
        if (challenge.group && satisfiedGroups.has(challenge.group)) continue;

        if (challenge.type === 'agent_allow_list') {
          const response = await this.handleAgentAllowList(challenge);
          if (response) {
            session = await session.verify(challenge.id, response);
            if (challenge.group) satisfiedGroups.add(challenge.group);
            madeProgress = true;
            break;
          }
          continue;
        }

        if (challenge.type === 'hc_auth_approval') {
          // Polling type: show waiting UI, poll for resolution
          this.currentChallenge = challenge;
          if (++pollCount > this.maxPollAttempts) {
            this.currentChallenge = null;
            throw new Error('Verification timed out. Please try again.');
          }
          await delay(session.pollIntervalMs ?? 2000);
          session = await session.pollStatus();
          this.currentChallenge = null;
          madeProgress = true;
          break;
        }

        // Interactive challenge: prompt user (resets poll count since user is active)
        pollCount = 0;
        const response = await this.promptForChallenge(challenge);
        session = await session.verify(challenge.id, response);
        if (challenge.group) satisfiedGroups.add(challenge.group);
        madeProgress = true;
        break;
      }

      if (!madeProgress) {
        if (++pollCount > this.maxPollAttempts) {
          throw new Error('Verification timed out. Please try again.');
        }
        await delay(session.pollIntervalMs ?? 2000);
        session = await session.pollStatus();
      }
    }

    if (session.status === 'rejected') {
      this.flowStatus = 'rejected';
      this.statusReason = session.reason ?? 'Join request was rejected';
      this.dispatchEvent(
        new CustomEvent<JoinErrorDetail>('join-error', {
          detail: { error: new JoiningError('join_rejected', this.statusReason, 0) },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    this.flowStatus = 'provisioning';
    const provision = await session.getProvision();

    this.flowStatus = 'ready';
    this.dispatchEvent(
      new CustomEvent<JoinCompleteDetail>('join-complete', {
        detail: { provision, claims: this.collectedClaims },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async handleAgentAllowList(challenge: Challenge): Promise<string | null> {
    if (!this.signNonce) return null;

    const nonceB64 = challenge.metadata?.nonce as string | undefined;
    if (!nonceB64) return null;

    const nonceBytes = base64ToUint8Array(nonceB64);
    const signature = await this.signNonce(nonceBytes);
    return uint8ArrayToBase64(signature);
  }

  protected promptForChallenge(challenge: Challenge): Promise<string> {
    return new Promise((resolve) => {
      this.currentChallenge = challenge;
      this.pendingChallengeResolve = resolve;
    });
  }

  protected handleClaimsSubmitted(e: CustomEvent<ClaimsSubmittedDetail>) {
    this.collectedClaims = e.detail.claims;
    const client = this.getClient();
    this.executeJoin(client).catch((err) => this.handleError(err));
  }

  protected handleChallengeResponse(e: CustomEvent<ChallengeResponseDetail>) {
    if (this.pendingChallengeResolve) {
      this.pendingChallengeResolve(e.detail.response);
      this.pendingChallengeResolve = null;
      this.currentChallenge = null;
    }
  }

  protected handleRetry() {
    this.start();
  }

  protected handleError(e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e));
    this.flowStatus =
      error instanceof JoiningError && error.code === 'join_rejected'
        ? 'rejected'
        : 'error';
    this.statusReason = error.message;
    this.dispatchEvent(
      new CustomEvent<JoinErrorDetail>('join-error', {
        detail: { error },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override render() {
    return html`
      <div part="flow">
        <joining-status
          .status=${this.flowStatus}
          .reason=${this.statusReason}
          @retry=${this.handleRetry}
        ></joining-status>

        ${this.flowStatus === 'collecting-claims'
          ? html`
              <joining-claims-form
                .authMethods=${this.authMethods}
                @claims-submitted=${this.handleClaimsSubmitted}
                @claims-cancelled=${() => this.handleError(new Error('Cancelled'))}
              ></joining-claims-form>
            `
          : nothing}

        ${this.currentChallenge
          ? html`
              <joining-challenge-dialog
                .challenge=${this.currentChallenge}
                .open=${true}
                @challenge-response=${this.handleChallengeResponse}
                @challenge-cancelled=${() => this.handleError(new Error('Challenge cancelled'))}
              ></joining-challenge-dialog>
            `
          : nothing}
      </div>
    `;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToUint8Array(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

declare global {
  interface HTMLElementTagNameMap {
    'joining-flow': JoiningFlow;
  }
}
