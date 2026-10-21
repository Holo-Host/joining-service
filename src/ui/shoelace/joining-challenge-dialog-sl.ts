import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Challenge } from '../../types.js';
import type { ChallengeResponseDetail } from '../joining-challenge-dialog.js';
import {
  LINK_CHALLENGE_TYPE,
  ResendClock,
  linkStateLine,
  type ChallengeResendDetail,
} from '../link-challenge.js';

import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/spinner/spinner.js';

const AUTO_CHALLENGE_TYPES = new Set(['agent_allow_list', 'open']);
const POLLING_TYPES = new Set(['hc_auth_approval', LINK_CHALLENGE_TYPE]);

const CHALLENGE_INPUT: Record<string, { label: string; inputType: string; placeholder: string }> = {
  invite_code: { label: 'Invite Code', inputType: 'text', placeholder: 'Enter your invite code' },
  email_code: { label: 'Verification Code', inputType: 'text', placeholder: '123456' },
  sms_code: { label: 'Verification Code', inputType: 'text', placeholder: '123456' },
};

@customElement('joining-challenge-dialog-sl')
export class JoiningChallengeDialogSl extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--sl-font-sans);
    }
    .heading {
      font-size: var(--sl-font-size-large, 1.25rem);
      font-weight: var(--sl-font-weight-semibold, 600);
      margin: 0 0 0.5rem 0;
    }
    .description {
      color: var(--sl-color-neutral-800, #333);
      font-size: var(--sl-font-size-medium, 1rem);
      line-height: 1.5;
      margin-bottom: var(--joining-field-spacing, 1rem);
    }
    .form-field {
      margin-bottom: var(--joining-field-spacing, 1rem);
    }
    .waiting {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      padding: 2rem 0;
      color: var(--sl-color-neutral-600, #666);
    }
    .state {
      margin: 0;
    }
    .notice {
      color: var(--sl-color-danger-700, #b91c1c);
    }
    .waiting sl-spinner {
      font-size: 2rem;
      --indicator-color: var(--sl-color-primary-600, #2563eb);
    }
    .actions {
      display: flex;
      gap: var(--joining-action-gap, 0.5rem);
      justify-content: flex-end;
      margin-top: var(--joining-action-margin-top, 1.5rem);
    }
    .actions sl-button::part(label) {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  `;

  @property({ type: Object })
  challenge: Challenge | null = null;

  @property({ type: Boolean, reflect: true })
  open = false;

  /** A message to show under the resend button, such as why the last resend failed. */
  @property({ attribute: false })
  notice?: string;

  @state()
  private inputValue = '';

  private resendClock = new ResendClock(this, () => this.challenge);

  prompt(challenge: Challenge): Promise<string> {
    return new Promise((resolve, reject) => {
      this.challenge = challenge;
      this.inputValue = '';
      this.open = true;

      const handleResponse = (e: Event) => {
        const detail = (e as CustomEvent<ChallengeResponseDetail>).detail;
        cleanup();
        resolve(detail.response);
      };

      const handleCancel = () => {
        cleanup();
        reject(new Error('Challenge cancelled'));
      };

      const cleanup = () => {
        this.removeEventListener('challenge-response', handleResponse);
        this.removeEventListener('challenge-cancelled', handleCancel);
        this.open = false;
        this.challenge = null;
      };

      this.addEventListener('challenge-response', handleResponse);
      this.addEventListener('challenge-cancelled', handleCancel);
    });
  }

  close() {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('challenge-cancelled', { bubbles: true, composed: true }),
    );
  }

  private handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.challenge || !this.inputValue.trim()) return;

    this.dispatchEvent(
      new CustomEvent<ChallengeResponseDetail>('challenge-response', {
        detail: {
          challengeId: this.challenge.id,
          response: this.inputValue.trim(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleResend() {
    if (!this.challenge) return;
    this.dispatchEvent(
      new CustomEvent<ChallengeResendDetail>('challenge-resend', {
        detail: { challengeId: this.challenge.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override render() {
    if (!this.challenge) return nothing;
    if (!this.open) return nothing;
    if (AUTO_CHALLENGE_TYPES.has(this.challenge.type)) return nothing;

    const isPolling = POLLING_TYPES.has(this.challenge.type);

    return html`
      <h3 class="heading" part="heading">${isPolling ? 'Please Wait' : 'Verification Confirmation'}</h3>
      <p class="description" part="description">${this.challenge.description}</p>

      ${this.challenge.type === LINK_CHALLENGE_TYPE
        ? html`
            <div class="waiting">
              <sl-spinner></sl-spinner>
              <p class="state" part="state" role="status" aria-live="polite">${linkStateLine(this.challenge)}</p>
            </div>
            <div class="actions" part="actions">
              <sl-button
                variant="default"
                ?disabled=${!this.resendClock.ready}
                @click=${this.handleResend}
              >Send the email again</sl-button>
            </div>
            ${this.notice ? html`<p class="notice" part="notice" role="alert">${this.notice}</p>` : nothing}
          `
        : isPolling
        ? html`
            <div class="waiting">
              <sl-spinner></sl-spinner>
              <span>Waiting for approval...</span>
            </div>
          `
        : html`
            <div class="form-field">${this.renderChallengeInput()}</div>
            <div class="actions" part="actions">
              <sl-button
                variant="default"
                @click=${() => this.close()}
              >Cancel</sl-button>
              <sl-button
                variant="primary"
                ?disabled=${!this.inputValue.trim()}
                @click=${this.handleSubmit}
              >Verify</sl-button>
            </div>
          `}
    `;
  }

  private renderChallengeInput() {
    if (!this.challenge) return nothing;

    const config = CHALLENGE_INPUT[this.challenge.type];

    if (config) {
      return html`
        <sl-input
          label=${config.label}
          type=${config.inputType}
          placeholder=${config.placeholder}
          value=${this.inputValue}
          @sl-input=${(e: CustomEvent) => {
            this.inputValue = (e.target as HTMLInputElement).value;
          }}
          required
        ></sl-input>
      `;
    }

    return html`
      <slot name=${`challenge-${this.challenge.type}`}>
        <sl-input
          label="Response"
          placeholder="Enter your response"
          value=${this.inputValue}
          @sl-input=${(e: CustomEvent) => {
            this.inputValue = (e.target as HTMLInputElement).value;
          }}
          required
        ></sl-input>
      </slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'joining-challenge-dialog-sl': JoiningChallengeDialogSl;
  }
}
