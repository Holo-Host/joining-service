# Dynamic Linker Registration

## Problem

Today, linker URLs are statically configured in the joining service -- either hardcoded in `config.json` (Node.js) or manually written to Cloudflare KV via `wrangler kv:key put` (Workers). This means:

- Adding or removing a linker requires manual intervention
- A linker whose URL changes (e.g., Cloudflare tunnel restart) goes stale until someone updates the config
- There is no automated way for a linker to announce its availability
- Linker operators and joining service operators must coordinate out-of-band for every URL change

This document describes a design for **dynamic linker registration** where linkers automatically join and leave the pool, authenticated by a stable cryptographic identity.

## Actors

| Actor | Role |
|-------|------|
| **Joining Service Operator (JSO)** | Runs the joining service for a specific hApp. Controls which linkers may serve that app's agents. |
| **Linker Operator (LO)** | Runs linker infrastructure. May serve multiple apps. Is a separate party from the JSO. |
| **HWC Client** | Browser extension. Receives linker URLs from the joining service during provisioning. |

## Design Principles

1. **The JSO controls access.** Linkers cannot add themselves to the pool without prior authorization from the JSO.
2. **The linker's stable identity is an ed25519 public key**, not a URL. URLs change (tunnels, restarts, migrations); the keypair persists.
3. **Authorization (invite) and identity (keypair) are separate concerns.** An invite token grants permission; the keypair proves who is using it.
4. **Heartbeat-based liveness.** Linkers periodically re-register. If they stop, they expire from the pool. No separate health-check infrastructure needed.

## Linker Identity

The h2hc-linker already generates an ed25519 keypair at startup for signing Kitsune2 report entries (`linker_report.rs`). Currently this keypair is **ephemeral** -- regenerated on every restart.

This design requires the keypair to be **persistent**:

- On first run, generate a keypair and write it to disk (configurable path via `H2HC_LINKER_KEY_FILE`, default `./linker-key.ed25519`)
- On subsequent runs, load the existing keypair
- For container deployments where files are impractical, accept `H2HC_LINKER_PRIVATE_KEY` as an env var (base64-encoded)
- The same keypair is used for both report signing and registration

The public key becomes the linker's stable identifier across URL changes, restarts, and redeployments.

## Registration Flow

### Step 1: JSO Creates an Invitation

The joining service operator creates a linker invite via the admin API. This happens once per linker (or once per batch if using a reusable invite).

```
POST /v1/admin/linker-invites
Authorization: Bearer <admin-secret>

{
  "label": "partner-acme-us-east",
  "capabilities": ["dht_read", "dht_write", "k2"],
  "max_uses": 1,
  "expires_at": "2026-12-31T00:00:00Z"    // optional
}

Response:
{
  "invite_token": "lnk_abc123..."
}
```

The JSO sends the `invite_token` to the linker operator through whatever channel they use (email, dashboard, Slack, etc.).

### Step 2: LO Configures the Linker

The linker operator adds the invite token and joining service URL to their linker's configuration:

```bash
H2HC_LINKER_JOINING_SERVICE_URL=https://join.example.com
H2HC_LINKER_INVITE_TOKEN=lnk_abc123...
H2HC_LINKER_PUBLIC_URL=wss://my-linker.example.com:8090
H2HC_LINKER_KEY_FILE=./linker.key
H2HC_LINKER_ADMIN_SECRET=my-chosen-admin-secret
```

### Step 3: Linker Heartbeats

On startup (and periodically thereafter), the linker sends a signed heartbeat to the joining service:

```
POST /v1/linkers/heartbeat

{
  "pubkey": "<base64 ed25519 public key>",
  "invite_token": "lnk_abc123...",
  "linker_url": "wss://my-linker.example.com:8090",
  "admin_url": "https://my-linker.example.com",
  "admin_secret": "<bearer token for /admin/agents callbacks>",
  "timestamp": "2026-03-31T12:00:00Z",
  "signature": "<base64 ed25519 signature>"
}

Response:
{
  "registered": true,
  "ttl_seconds": 300
}
```

The signature covers: `pubkey + linker_url + admin_url + timestamp` (concatenated canonical form). This proves the caller owns the private key corresponding to the declared pubkey.

### Step 4: Joining Service Processes the Heartbeat

On receiving a heartbeat, the joining service:

1. **First heartbeat (invite_token present):**
   - Validates the invite token exists and is not expired or exhausted
   - Verifies the ed25519 signature
   - Binds the pubkey to the invite (records it in `used_by`)
   - Creates a `RegisteredLinker` entry with capabilities from the invite
   - Stores the admin_secret for agent authorization callbacks

2. **Subsequent heartbeats (pubkey already registered):**
   - Looks up the pubkey in registered linkers
   - Verifies the signature
   - Updates `linker_url`, `admin_url`, `admin_secret`, and `last_heartbeat`
   - Resets `expires_at` to `now + TTL`
   - The `invite_token` field is ignored (can be omitted)

3. **Expired or unknown pubkey, invalid invite:**
   - Returns 401/403, linker is not added to the pool

### Step 5: Clients Receive Linker URLs

No change to the client-facing API. The `/v1/join/{session}/provision` and `/v1/reconnect` endpoints continue to return all active linker URLs. The only difference is that the list is now populated dynamically from heartbeating linkers rather than static config.

## URL Changes

When a linker's URL changes (tunnel restart, migration, etc.):

1. The linker detects its URL has changed (or simply always sends its current URL)
2. The next heartbeat carries the new URL
3. The joining service updates the URL for that pubkey
4. Subsequent client provision/reconnect calls get the new URL

No manual intervention required. The pubkey is stable; only the URL changes.

## Liveness and Expiry

- Each heartbeat resets the linker's `expires_at` to `last_heartbeat + TTL` (e.g., 5 minutes)
- If a linker stops heartbeating (crash, network loss, shutdown), its entry expires
- The `getLinkerRegistrations()` method filters out expired entries at read time
- Optionally, a Cloudflare Cron Trigger runs periodically to clean up expired entries from KV

On graceful shutdown, the linker can send a deregistration request:

```
DELETE /v1/linkers/register
{
  "pubkey": "<base64>",
  "timestamp": "...",
  "signature": "..."
}
```

This immediately removes it from the pool rather than waiting for TTL expiry.

## Agent Authorization

When a new HWC agent completes joining, the existing `notifyLinkers()` flow is unchanged in behavior but its data source changes:

**Before:** reads `LinkerRegistration[]` from static config or KV `linker_registrations` key
**After:** reads from the registered linkers pool, merging each linker's `admin_url` + `admin_secret` (from heartbeats) with `capabilities` (from the invite that authorized it)

The joining service calls `POST /admin/agents` on each active linker, exactly as it does today.

## Data Model

### Linker Invite (KV: `linker_invite:{token}`)

```typescript
interface LinkerInvite {
  token: string;                       // "lnk_abc123..."
  label?: string;                      // human-readable, for ops
  capabilities: LinkerCapability[];    // granted to agents on this linker
  max_uses?: number;                   // null = unlimited
  used_by: string[];                   // pubkeys that claimed this invite
  created_at: string;                  // ISO 8601
  expires_at?: string;                 // ISO 8601, optional
}
```

### Registered Linker (KV: `registered_linker:{pubkey}`)

```typescript
interface RegisteredLinker {
  pubkey: string;                      // ed25519 public key, base64
  invite_token: string;               // which invite authorized this linker
  label?: string;                      // inherited from invite
  capabilities: LinkerCapability[];    // inherited from invite
  admin_secret: string;               // from linker's heartbeat
  linker_url: string;                  // current WSS URL, updated each heartbeat
  admin_url: string;                   // current admin URL
  last_heartbeat: string;             // ISO 8601
  expires_at: string;                  // last_heartbeat + TTL
}
```

### Mapping to Existing Types

The `RegisteredLinker` maps to the existing `LinkerRegistration` interface:

```typescript
// Existing type (unchanged)
interface LinkerRegistration {
  linker_url: LinkerUrl;
  admin?: LinkerAdminInfo;
}

// Conversion from RegisteredLinker
function toLinkerRegistration(r: RegisteredLinker): LinkerRegistration {
  return {
    linker_url: { url: r.linker_url, expires_at: r.expires_at },
    admin: { url: r.admin_url, secret: r.admin_secret },
  };
}
```

## Deauthorization

The JSO can revoke a linker at any time:

```
DELETE /v1/admin/linkers/:pubkey
Authorization: Bearer <admin-secret>
```

This removes the `RegisteredLinker` entry from KV. The linker's subsequent heartbeats will be rejected (unknown pubkey with no valid invite to re-claim).

Revoking an invite (`DELETE /v1/admin/linker-invites/:token`) prevents new linkers from using it but does **not** remove linkers already registered through that invite. To remove those, revoke each linker by pubkey.

## API Summary

### Admin Endpoints (protected by joining service admin secret)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/admin/linker-invites` | Create a linker invitation |
| `GET` | `/v1/admin/linker-invites` | List all invitations |
| `DELETE` | `/v1/admin/linker-invites/:token` | Revoke an invitation |
| `GET` | `/v1/admin/linkers` | List all registered linkers (with status) |
| `DELETE` | `/v1/admin/linkers/:pubkey` | Deauthorize a linker |

### Linker Endpoints (authenticated by signature)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/linkers/heartbeat` | Register or refresh a linker |
| `DELETE` | `/v1/linkers/register` | Deregister on graceful shutdown |

### Unchanged Client Endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/v1/join/{session}/provision` | Now returns dynamically-registered linker URLs |
| `POST` | `/v1/reconnect` | Same |

## Linker-Side Changes

### New Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `H2HC_LINKER_KEY_FILE` | No (default: `./linker-key.ed25519`) | Path to persistent ed25519 keypair file |
| `H2HC_LINKER_PRIVATE_KEY` | No | Alternative: base64-encoded private key (for containers) |
| `H2HC_LINKER_JOINING_SERVICE_URL` | No | Joining service base URL for heartbeat registration |
| `H2HC_LINKER_INVITE_TOKEN` | No | Invite token from the JSO (needed for first heartbeat only, but can be left configured) |
| `H2HC_LINKER_PUBLIC_URL` | No | Externally-reachable WSS URL (linker cannot infer this, especially behind tunnels) |

All new variables are optional. A linker with none of these set behaves exactly as it does today (no registration, no persistent key). Registration is opt-in.

### New Module: `registration.rs`

- Startup: load or generate keypair
- Spawn background task: heartbeat loop (interval = `ttl_seconds / 2`)
- On shutdown: best-effort deregistration
- Share the persistent `SigningKey` with `linker_report.rs` (both use the same identity)

## Backward Compatibility

- Joining services without the new endpoints continue to work -- linkers without `H2HC_LINKER_JOINING_SERVICE_URL` set do not attempt registration
- The `KvUrlProvider` merges statically-configured `linker_registrations` (existing KV key) with dynamically-registered linkers. Both sources contribute to the pool. This allows gradual migration.
- Existing client-facing APIs are unchanged

## Scope Exclusions

This design intentionally does not address:

- **Load-aware routing**: all clients still receive all active linker URLs. Sharding or weighted selection is a separate concern.
- **Region-aware routing**: the `label` field on invites can carry region info, but no routing logic is proposed here.
- **Multi-hApp joining service**: each joining service instance serves one hApp. A linker that serves multiple apps registers separately with each joining service.
- **Log-collector registration**: the persistent keypair enables this, but the log-collector protocol is out of scope.

## Implementation Sequence

1. **h2hc-linker: persistent keypair** -- modify `linker_report.rs` to load/generate/persist the keypair. This is independently useful for report signing regardless of registration.

2. **joining-service: invite + registration endpoints** -- add the admin and linker-facing routes, KV storage for invites and registered linkers, signature verification, TTL-based expiry.

3. **joining-service: KvUrlProvider merge** -- update `getLinkerRegistrations()` to combine static config with dynamic registrations.

4. **h2hc-linker: registration client** -- add `registration.rs` with heartbeat loop and graceful deregistration.

5. **Operational tooling** -- CLI commands or scripts for creating invites and inspecting the linker pool.
