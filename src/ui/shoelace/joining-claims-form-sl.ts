import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AuthMethodEntry, AuthMethod } from '../../types.js';
import type { ClaimsSubmittedDetail } from '../joining-claims-form.js';
import { LINK_CLAIM_INPUT } from '../link-challenge.js';

// Shoelace component imports (side-effect: registers custom elements)
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';

const AUTO_METHODS: Set<AuthMethod> = new Set(['open', 'agent_allow_list']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;

const CLAIM_INPUT: Record<string, { label: string; type: string; placeholder: string; claimKey: string; description: string }> = {
  invite_code: {
    label: 'Invite Code',
    type: 'text',
    placeholder: 'Enter your invite code',
    claimKey: 'invite_code',
    description: 'To join this network you need an invite code.',
  },
  email_code: {
    label: 'Email',
    type: 'email',
    placeholder: 'you@example.com',
    claimKey: 'email',
    description: 'To join this network, please provide your email address. A verification code will be sent to you.',
  },
  sms_code: {
    label: 'Phone Number',
    type: 'tel',
    placeholder: '+1 555 123 4567',
    claimKey: 'phone',
    description: 'To join this network, please provide your phone number. A verification code will be sent to you.',
  },
  didit_with_email: LINK_CLAIM_INPUT,
};

@customElement('joining-claims-form-sl')
export class JoiningClaimsFormSl extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: var(--sl-font-sans, sans-serif);
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
    .actions {
      display: flex;
      gap: var(--joining-action-gap, 0.5rem);
      justify-content: flex-end;
      margin-top: var(--joining-action-margin-top, 1.5rem);
    }
    /* Ensure button text is vertically centered */
    .actions sl-button::part(label) {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .or-group {
      border: 1px solid var(--sl-color-neutral-200, #e5e7eb);
      border-radius: var(--sl-border-radius-medium, 0.25rem);
      padding: var(--joining-group-padding, 1rem);
      margin-bottom: var(--joining-field-spacing, 1rem);
    }
    .or-group-label {
      font-size: var(--sl-font-size-small, 0.875rem);
      color: var(--sl-color-neutral-600, #666);
      margin-bottom: 0.5rem;
    }
  `;

  @property({ type: Array })
  authMethods: AuthMethodEntry[] = [];

  @state()
  private selectedInGroup: Record<number, AuthMethod> = {};

  @state()
  private values: Record<string, string> = {};

  private getInteractiveMethods(): Array<{ method: AuthMethod; groupIndex?: number }> {
    const result: Array<{ method: AuthMethod; groupIndex?: number }> = [];
    for (let i = 0; i < this.authMethods.length; i++) {
      const entry = this.authMethods[i];
      if (typeof entry === 'string') {
        if (!AUTO_METHODS.has(entry) && CLAIM_INPUT[entry]) {
          result.push({ method: entry });
        }
      } else if ('any_of' in entry) {
        const interactive = entry.any_of.filter(
          (m) => !AUTO_METHODS.has(m) && CLAIM_INPUT[m],
        );
        if (interactive.length > 0) {
          if (!this.selectedInGroup[i]) {
            this.selectedInGroup = { ...this.selectedInGroup, [i]: interactive[0] };
          }
          for (const m of interactive) {
            result.push({ method: m, groupIndex: i });
          }
        }
      }
    }
    return result;
  }

  private getActiveFields(
    methods: Array<{ method: AuthMethod; groupIndex?: number }>,
  ): AuthMethod[] {
    const seen = new Set<AuthMethod>();
    const active: AuthMethod[] = [];
    for (const { method, groupIndex } of methods) {
      if (seen.has(method)) continue;
      if (groupIndex !== undefined && this.selectedInGroup[groupIndex] !== method) continue;
      seen.add(method);
      active.push(method);
    }
    return active;
  }

  private isValid(): boolean {
    const methods = this.getInteractiveMethods();
    const activeFields = this.getActiveFields(methods);
    return activeFields.every((m) => {
      const val = (this.values[m] ?? '').trim();
      if (!val) return false;
      if (CLAIM_INPUT[m]?.type === 'email' && !EMAIL_RE.test(val)) return false;
      if (CLAIM_INPUT[m]?.type === 'tel' && !PHONE_RE.test(val)) return false;
      return true;
    });
  }

  private handleInput(method: string, value: string) {
    this.values = { ...this.values, [method]: value };
  }

  private handleTabShow(groupIndex: number, methods: AuthMethod[], e: CustomEvent) {
    const panel = (e as CustomEvent<{ name: string }>).detail.name;
    const method = methods.find((m) => m === panel);
    if (method) {
      this.selectedInGroup = { ...this.selectedInGroup, [groupIndex]: method };
    }
  }

  private handleSubmit(e: Event) {
    e.preventDefault();
    if (!this.isValid()) return;

    const methods = this.getInteractiveMethods();
    const activeFields = this.getActiveFields(methods);
    const claims: Record<string, string> = {};
    for (const m of activeFields) {
      const val = (this.values[m] ?? '').trim();
      const key = CLAIM_INPUT[m]?.claimKey ?? m;
      if (val) claims[key] = val;
    }

    this.dispatchEvent(
      new CustomEvent<ClaimsSubmittedDetail>('claims-submitted', {
        detail: { claims },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleCancel() {
    this.dispatchEvent(
      new CustomEvent('claims-cancelled', { bubbles: true, composed: true }),
    );
  }

  protected override render() {
    const methods = this.getInteractiveMethods();
    if (methods.length === 0) return nothing;

    const groups = new Map<number | 'standalone', Array<{ method: AuthMethod; groupIndex?: number }>>();
    for (const entry of methods) {
      const key = entry.groupIndex ?? 'standalone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    // Build description from the first active method's description
    const activeFields = this.getActiveFields(methods);
    const descriptions = [...new Set(
      activeFields.map((m) => CLAIM_INPUT[m]?.description).filter(Boolean),
    )];

    return html`
      <h3 class="heading" part="heading">Verification Required</h3>
      ${descriptions.map((d) => html`<p class="description" part="description">${d}</p>`)}
      <form @submit=${this.handleSubmit} novalidate>
        ${[...groups.entries()].map(([key, entries]) => {
          if (key === 'standalone') {
            return entries.map((e) => this.renderInput(e.method));
          }
          const groupIndex = key as number;
          const groupMethods = entries.map((e) => e.method);
          return this.renderOrGroup(groupIndex, groupMethods);
        })}
        <div class="actions" part="actions">
          <sl-button
            variant="default"
            @click=${this.handleCancel}
          >Cancel</sl-button>
          <sl-button
            variant="primary"
            type="submit"
            ?disabled=${!this.isValid()}
            @click=${this.handleSubmit}
          >Continue</sl-button>
        </div>
      </form>
    `;
  }

  private renderOrGroup(groupIndex: number, methods: AuthMethod[]) {
    const selected = this.selectedInGroup[groupIndex];
    return html`
      <div class="or-group" part="or-group">
        <div class="or-group-label">Choose a verification method</div>
        <sl-tab-group
          @sl-tab-show=${(e: CustomEvent) => this.handleTabShow(groupIndex, methods, e)}
        >
          ${methods.map(
            (m) => html`
              <sl-tab slot="nav" panel=${m} ?active=${selected === m}>
                ${CLAIM_INPUT[m]?.label ?? m}
              </sl-tab>
            `,
          )}
          ${methods.map(
            (m) => html`
              <sl-tab-panel name=${m}>
                ${this.renderInput(m)}
              </sl-tab-panel>
            `,
          )}
        </sl-tab-group>
      </div>
    `;
  }

  private renderInput(method: AuthMethod) {
    const config = CLAIM_INPUT[method];
    if (!config) {
      return html`<slot name=${method}></slot>`;
    }

    return html`
      <div class="form-field" part="field">
        <sl-input
          label=${config.label}
          type=${config.type}
          placeholder=${config.placeholder}
          value=${this.values[method] ?? ''}
          @sl-input=${(e: CustomEvent) =>
            this.handleInput(method, (e.target as HTMLInputElement).value)}
          required
        ></sl-input>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'joining-claims-form-sl': JoiningClaimsFormSl;
  }
}
