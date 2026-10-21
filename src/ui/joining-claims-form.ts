import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AuthMethodEntry, AuthMethod } from '../types.js';
import { LINK_CLAIM_INPUT } from './link-challenge.js';

/** Methods that require no user input. */
const AUTO_METHODS: Set<AuthMethod> = new Set([
  'open',
  'agent_allow_list',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;

/** Methods with built-in claim inputs. claimKey is the key sent to the server. */
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

export interface ClaimsSubmittedDetail {
  claims: Record<string, string>;
}

/**
 * Headless component that collects initial claims (invite code, email, etc.)
 * based on the auth methods advertised by the joining service.
 *
 * Renders plain HTML with no styling. Use CSS or the Shoelace wrapper for visuals.
 */
@customElement('joining-claims-form')
export class JoiningClaimsForm extends LitElement {
  /** Auth methods from JoiningServiceInfo.auth_methods */
  @property({ type: Array })
  authMethods: AuthMethodEntry[] = [];

  /** Currently selected method within an OR group. Keyed by group index. */
  @state()
  private selectedInGroup: Record<number, AuthMethod> = {};

  @state()
  private values: Record<string, string> = {};

  /** Disable shadow DOM so consumers can style freely. */
  protected override createRenderRoot() {
    return this;
  }

  /** Extract the flat list of interactive methods that need claim inputs. */
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
          // Default to first interactive method in group
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

  /** Check whether all required fields have values. */
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

  /** Get the methods whose inputs should currently be shown (respecting OR group selection). */
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

  private handleInput(method: string, value: string) {
    this.values = { ...this.values, [method]: value };
  }

  private handleGroupSelect(groupIndex: number, method: AuthMethod) {
    this.selectedInGroup = { ...this.selectedInGroup, [groupIndex]: method };
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

    // Group methods by groupIndex for OR group rendering
    const groups = new Map<number | 'standalone', Array<{ method: AuthMethod; groupIndex?: number }>>();
    for (const entry of methods) {
      const key = entry.groupIndex ?? 'standalone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    const activeFields = this.getActiveFields(methods);
    const descriptions = [...new Set(
      activeFields.map((m) => CLAIM_INPUT[m]?.description).filter(Boolean),
    )];

    return html`
      <h3 part="heading">Verification Required</h3>
      ${descriptions.map((d) => html`<p part="description">${d}</p>`)}
      <form
        part="form"
        @submit=${this.handleSubmit}
        novalidate
      >
        ${[...groups.entries()].map(([key, entries]) => {
          if (key === 'standalone') {
            return entries.map((e) => this.renderInput(e.method));
          }
          // OR group
          const groupIndex = key as number;
          const selected = this.selectedInGroup[groupIndex];
          return html`
            <fieldset part="or-group">
              <legend part="or-group-legend">Choose a verification method</legend>
              ${entries.map(
                (e) => html`
                  <label part="or-group-option">
                    <input
                      type="radio"
                      name="group-${groupIndex}"
                      .checked=${selected === e.method}
                      @change=${() => this.handleGroupSelect(groupIndex, e.method)}
                    />
                    ${CLAIM_INPUT[e.method]?.label ?? e.method}
                  </label>
                `,
              )}
              ${selected ? this.renderInput(selected) : nothing}
            </fieldset>
          `;
        })}
        <div part="actions">
          <button
            type="button"
            part="cancel-button"
            @click=${this.handleCancel}
          >Cancel</button>
          <button
            type="submit"
            part="submit-button"
            ?disabled=${!this.isValid()}
          >Continue</button>
        </div>
      </form>
    `;
  }

  private renderInput(method: AuthMethod) {
    const config = CLAIM_INPUT[method];
    if (!config) {
      return html`<slot name=${method}></slot>`;
    }

    return html`
      <div part="field">
        <label part="label" for="claim-${method}">${config.label}</label>
        <input
          part="input"
          id="claim-${method}"
          type=${config.type}
          placeholder=${config.placeholder}
          .value=${this.values[method] ?? ''}
          @input=${(e: InputEvent) =>
            this.handleInput(method, (e.target as HTMLInputElement).value)}
          required
          aria-required="true"
        />
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'joining-claims-form': JoiningClaimsForm;
  }
}
