/**
 * HTTP client for a single linker's admin API.
 *
 * Calls POST /admin/agents to add/update an agent's capabilities.
 * The linker API is idempotent: re-adding the same agent updates capabilities.
 *
 * Key format: the linker expects a full Holochain AgentPubKey (39-byte HoloHash,
 * base64-encoded) — the same format the joining service receives from clients.
 * No key conversion is needed (unlike hc-auth which requires raw ed25519 base64url).
 */

import type { LinkerAdminInfo, LinkerCapability } from './types.js';

const TIMEOUT_MS = 5_000;

export class LinkerAuthClient {
  private readonly adminUrl: string;
  private readonly authHeader: string;

  constructor(admin: LinkerAdminInfo) {
    this.adminUrl = admin.url.replace(/\/$/, '');
    this.authHeader = `Bearer ${admin.secret}`;
  }

  /**
   * Authorize an agent on this linker with the given capabilities.
   * Idempotent: calling again updates the agent's capability set.
   *
   * @param agentKey - base64-encoded 39-byte AgentPubKey (standard Holochain format)
   * @param capabilities - capability strings matching linker's snake_case enum
   * @param label - optional human-readable label for the agent
   */
  async authorizeAgent(
    agentKey: string,
    capabilities: LinkerCapability[],
    label?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      agent_pubkey: agentKey,
      capabilities,
    };
    if (label !== undefined) {
      body.label = label;
    }

    const resp = await fetch(`${this.adminUrl}/admin/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(
        `linker POST /admin/agents at ${this.adminUrl} returned ${resp.status}: ${await resp.text()}`,
      );
    }
  }
}
