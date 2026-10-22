import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { JoiningFlow } from '../joining-flow.js';

// Register Shoelace sub-components
import './joining-claims-form-sl.js';
import './joining-challenge-dialog-sl.js';
import './joining-status-sl.js';

@customElement('joining-flow-sl')
export class JoiningFlowSl extends JoiningFlow {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--sl-font-sans, sans-serif);
      max-width: var(--joining-max-width, 480px);
      margin: var(--joining-margin, 0 auto);
    }
    .flow {
      padding: var(--joining-padding, 1.5rem);
    }
    joining-status-sl {
      margin-bottom: 1rem;
    }
  `;

  /** Re-enable shadow DOM for Shoelace styling isolation. */
  protected override createRenderRoot(): HTMLElement | ShadowRoot {
    return this.attachShadow({ mode: 'open' });
  }

  protected override render() {
    return html`
      <div class="flow" part="flow">
        <joining-status-sl
          .status=${this.flowStatus}
          .reason=${this.statusReason}
          @retry=${this.handleRetry}
        ></joining-status-sl>

        ${this.flowStatus === 'collecting-claims'
          ? html`
              <joining-claims-form-sl
                .authMethods=${this.authMethods}
                @claims-submitted=${this.handleClaimsSubmitted}
                @claims-cancelled=${() => this.handleError(new Error('Cancelled'))}
              ></joining-claims-form-sl>
            `
          : nothing}

        ${this.currentChallenge
          ? html`
              <joining-challenge-dialog-sl
                .challenge=${this.currentChallenge}
                .open=${true}
                .notice=${this.pollNotice ?? this.resendNotice}
                @challenge-response=${this.handleChallengeResponse}
                @challenge-resend=${this.handleChallengeResend}
                @challenge-cancelled=${() => this.handleError(new Error('Challenge cancelled'))}
              ></joining-challenge-dialog-sl>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'joining-flow-sl': JoiningFlowSl;
  }
}
