# Joining Service Deployment Guide

Three deployment targets are supported, all using the same Hono application core:

| Target | Session store | Entry point | Use case |
|--------|--------------|-------------|----------|
| Local / manual | `memory` or `sqlite` | `src/server.ts` | Development, local testing |
| Cloudflare Workers | `cloudflare-kv` | Custom worker entry | Production edge |
| Edge node (Linux VPS) | `sqlite` | `dist/server.js` | Self-hosted production |

---

## Membrane proof signing key and DNA progenitor

This section is prerequisite reading before deploying with membrane proofs. Skip it only if your hApp uses `auth_methods: ["open"]` and does not require membrane proofs.

### The bootstrap ordering problem

The signing key is not an arbitrary key. The ed25519 public key derived from the seed must be embedded in the DNA's `properties` as the **progenitor** before the hApp bundle is compiled. The DNA's `genesis_self_check` Wasm callback validates every membrane proof by checking that its `signer` field matches the progenitor embedded in the DNA at compile time.

The ordering constraint is:

```
1. Generate seed (once, offline)
2. Derive public key from seed
3. Embed public key as progenitor in DNA source
4. Build .happ bundle
5. Deploy joining service with the same seed
```

Steps 1-4 must happen before step 5. If the key is lost or rotated after the DNA is compiled, you must rebuild and redeploy the hApp.

### Generating the key pair

Run the script in this repo once, before building the hApp bundle:

```sh
npm run gen-signing-key
```

The script ([scripts/gen-signing-key.ts](scripts/gen-signing-key.ts)) uses `@holo-host/lair` to derive the key pair through the same libsodium path used by `LairProofGenerator` at runtime, so the public key is guaranteed to match. Once `@holo-host/lair` is published to npm as a normal package the `NODE_OPTIONS=--preserve-symlinks` workaround in the npm script can be dropped -- no logic change to the script required.

Store the seed hex in a secrets manager (Vault, AWS Secrets Manager, 1Password, etc.) or a 600-permissioned file on the server. **Never commit it to version control.**

The `AgentPubKey` string (starting with `uhCAk`) goes into your DNA's properties as the progenitor (see the DNA validation section below).

After changing DNA properties the DNA hash changes, so all previously compiled bundles are invalidated.

### Membrane proof wire format

The joining service produces a `MembraneProof` (which in Holochain is `SerializedBytes` -- msgpack bytes). The wire format is:

```
MembraneProofEnvelope (msgpack map, named fields):
  signature:  Uint8Array(64)   -- ed25519 signature over msgpack(data)
  data:       MembraneProofData (msgpack map, named fields):
    for_agent:  Uint8Array(39)   -- AgentPubKey bytes (binary, not base64)
    dna_hash:   Uint8Array(39)   -- DnaHash bytes (binary, not base64)
    timestamp:  String           -- ISO 8601
    nonce:      String           -- random hex
  signer:     Uint8Array(39)   -- signer's AgentPubKey bytes
```

All hash fields are raw 39-byte HoloHash binary in msgpack, matching how `AgentPubKey` and `DnaHash` serialize via `serde` in Holochain's `holo_hash` crate. This means the Rust side can deserialize them directly into native HoloHash types with no string parsing.

### DNA-side validation (Rust integrity zome)

Add these types and the validation function to your integrity zome. The pattern follows the established membrane proof approach used in Holochain apps (e.g. Volla chat):

```rust
use hdi::prelude::*;

// -- Types for deserializing the membrane proof --

#[derive(Serialize, Deserialize, Debug, SerializedBytes, Clone)]
pub struct MembraneProofData {
    pub for_agent: AgentPubKey,
    pub dna_hash: DnaHash,
    pub timestamp: String,
    pub nonce: String,
}

#[derive(Serialize, Deserialize, Debug, SerializedBytes)]
pub struct MembraneProofEnvelope {
    pub signature: Signature,
    pub data: MembraneProofData,
    pub signer: AgentPubKey,
}

// -- DNA properties (set at bundle compile time) --

#[derive(Serialize, Deserialize, Debug, SerializedBytes, Clone)]
pub struct Properties {
    pub progenitor: AgentPubKey,
}

// -- Validation logic --

pub fn check_membrane_proof(
    agent_pub_key: AgentPubKey,
    membrane_proof: Option<MembraneProof>,
) -> ExternResult<ValidateCallbackResult> {
    let info = dna_info()?;

    let props = Properties::try_from(info.modifiers.properties)
        .map_err(|e| wasm_error!(e))?;

    match membrane_proof {
        None => Ok(ValidateCallbackResult::Invalid(
            "Membrane proof required".to_string(),
        )),
        Some(serialized_proof) => {
            // 1. Deserialize the envelope from SerializedBytes
            let envelope = MembraneProofEnvelope::try_from(
                (*serialized_proof).clone()
            ).map_err(|e| wasm_error!(e))?;

            // 2. Verify the signer is the authorized progenitor
            if envelope.signer != props.progenitor {
                return Ok(ValidateCallbackResult::Invalid(
                    "Signer is not the authorized progenitor".to_string(),
                ));
            }

            // 3. Verify the proof is for this agent
            if envelope.data.for_agent != agent_pub_key {
                return Ok(ValidateCallbackResult::Invalid(
                    "Membrane proof is not for this agent".to_string(),
                ));
            }

            // 4. Verify the signature over the data
            //    verify_signature re-serializes envelope.data with
            //    rmp_serde::to_vec_named and verifies the ed25519 signature.
            if verify_signature(
                props.progenitor,
                envelope.signature,
                envelope.data,
            )? {
                Ok(ValidateCallbackResult::Valid)
            } else {
                Ok(ValidateCallbackResult::Invalid(
                    "Membrane proof signature is invalid".to_string(),
                ))
            }
        }
    }
}

#[hdk_extern]
pub fn genesis_self_check(
    data: GenesisSelfCheckData,
) -> ExternResult<ValidateCallbackResult> {
    check_membrane_proof(data.agent_key, data.membrane_proof)
}
```

The same `check_membrane_proof` function should also be called from your `validate` callback for `OpRecord::StoreRecord` when the record is an `AgentValidationPkg`:

```rust
#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<(), ()>()? {
        FlatOp::StoreRecord(OpRecord::CreateAgent {
            agent_pub_key,
            membrane_proof,
        }) => check_membrane_proof(agent_pub_key, membrane_proof),
        // ... other validation cases ...
        _ => Ok(ValidateCallbackResult::Valid),
    }
}
```

This ensures that peers also validate the membrane proof, not just the joining agent.

### DNA properties setup

In your `dna.yaml`, add the progenitor key from `npm run gen-signing-key`:

```yaml
# dna.yaml
properties:
  progenitor: uhCAkXXXX...  # AgentPubKey from gen-signing-key output
```

### Obtaining the DNA hash

`roles.<name>.dna_hash` must be the **post-modifiers** DNA hash — network_seed and properties (including the progenitor above) are hashed into the DNA, so any of them changes the hash. Install the hApp with your actual modifiers on a conductor and read the resulting hash back from that install; don't use the bundle's base hash or compute it by hand.

```sh
hc s call list-apps
# or, for a specific app:
hc s call --running list-cells
```

The cell IDs returned are `[DnaHash, AgentPubKey]` pairs — take the `DnaHash` for the role's cell and put its base64 form (`uhC0k...`) into `roles.<name>.dna_hash`. A mismatched hash doesn't fail loudly: the joining service still issues membrane proofs, but the DNA's `genesis_self_check` rejects them (or peers reject a mismatched network) because the proof is bound to the wrong network.

### Cross-language signature verification

The joining service (TypeScript) signs with `@msgpack/msgpack` encode and `@holo-host/lair` for ed25519. The DNA (Rust) verifies with `hdi::prelude::verify_signature`, which re-serializes the `MembraneProofData` struct using `rmp_serde::to_vec_named` before checking the signature.

For this to work, the msgpack bytes produced by both sides must be identical. This holds because:

1. Both use named-field map encoding (JS objects preserve insertion order; Rust structs serialize in declaration order)
2. Hash fields are binary in both (Uint8Array in JS, `serialize_bytes` in Rust)
3. String fields are plain msgpack strings in both

The joining service's test suite (`test/membrane-proof.test.ts`) verifies this: it re-encodes the deserialized data and confirms the signature still verifies, simulating the same round-trip that `verify_signature` performs in WASM.

---

## 1. Manual (local testing)

### Prerequisites

- Node.js 20+
- `npm install`

### Configuration file

Create a `config.json` in the project root. Minimum viable config (no membrane proofs):

```json
{
  "happ": {
    "id": "my-happ",
    "name": "My hApp",
    "happ_bundle_url": "http://localhost:8080/my-happ.happ"
  },
  "auth_methods": ["open"],
  "linker_registrations": [{"linker_url": {"url": "wss://linker.example.com:8090"}}]
}
```

With email-code auth and file transport (codes written to disk, not sent):

```json
{
  "happ": {
    "id": "my-happ",
    "name": "My hApp"
  },
  "auth_methods": ["email_code"],
  "linker_registrations": [{"linker_url": {"url": "wss://linker.example.com:8090"}}],
  "email": {
    "provider": "file",
    "output_dir": "./dev-emails"
  },
  "session": {
    "store": "sqlite",
    "db_path": "./dev-sessions.db"
  }
}
```

Email codes are written as `.txt` files under `./dev-emails/`. Open them to get the code.

With membrane proofs (dev — ephemeral key, NOT safe for production):

```json
{
  "happ": {
    "id": "my-happ",
    "name": "My hApp"
  },
  "auth_methods": ["open"],
  "linker_registrations": [{"linker_url": {"url": "wss://linker.example.com:8090"}}],
  "roles": {
    "main": {
      "dna_hash": "uhC0k..."
    }
  },
  "membrane_proof": {
    "enabled": true
  }
}
```

Omitting `signing_key_path` causes the server to generate an ephemeral key at startup. The ephemeral key changes on every restart, so proofs issued before a restart will not validate. Use this only in development against a throwaway network seed.

With membrane proofs (production — stable key):

```json
{
  "happ": {
    "id": "my-happ",
    "name": "My hApp"
  },
  "auth_methods": ["open"],
  "linker_registrations": [{"linker_url": {"url": "wss://linker.example.com:8090"}}],
  "roles": {
    "main": {
      "dna_hash": "uhC0k...",
      "modifiers": {
        "network_seed": "my-happ-mainnet-2026"
      }
    }
  },
  "membrane_proof": {
    "enabled": true,
    "signing_key_path": "./signing-key.hex"
  }
}
```

The `signing_key_path` file must contain the 64-character hex seed generated in the key generation step above. See the [membrane proof section](#membrane-proof-signing-key-and-dna-progenitor) for how that key relates to your DNA.

### Run in dev mode (hot reload)

```sh
npm run dev -- config.json
# or with default path ./config.json:
npm run dev
```

The server starts on port `3000` (override with `"port"` in config).

### Run built output

```sh
npm run build
node dist/server.js config.json
```

### Verify it works

```sh
curl http://localhost:3000/.well-known/holo-joining
curl http://localhost:3000/v1/info
```

### Configuration reference

The config file is JSON. Top-level keys `linker_registrations` and `http_gateways` are extracted before the rest is passed to `resolveConfig()`. All other fields map to the `ServiceConfig` interface in `src/config.ts`.

The older `dna_hashes`/`dna_modifiers` fields no longer exist — a config containing either one is rejected at startup with an error pointing to `roles`.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `happ.id` | string | required | Machine-readable identifier |
| `happ.name` | string | required | Display name |
| `happ.description` | string | — | Optional description |
| `happ.icon_url` | string | — | Icon URL for display |
| `happ.happ_bundle_url` | string | — | URL clients use to fetch the .happ bundle |
| `auth_methods` | AuthMethodEntry[] | required | e.g. `["open"]`, `["email_code"]`, `["invite_code"]`, `[{"any_of": ["invite_code", "agent_allow_list"]}]` |
| `linker_registrations` | LinkerRegistration[] | — | Top-level config key (not in ServiceConfig). Array of `{linker_url: {url}, admin?: {url, secret}}` objects |
| `http_gateways` | HttpGateway[] | — | Top-level config key (not in ServiceConfig). Read-only gateway instances |
| `linker_info.selection_mode` | `"assigned"` \| `"client_choice"` | — | How linker URLs are assigned to agents |
| `linker_info.region_hints` | string[] | — | Region hints for linker selection |
| `roles` | Record\<role_name, {dna_hash?, modifiers?}\> | — | Role-centric configuration: `{role_name: {dna_hash?: "...", modifiers?: {...}}}`. `dna_hash` is required per-role only when `membrane_proof.enabled` is true (it binds the membrane proof to a network); when present it is always validated. See [Obtaining the DNA hash](#obtaining-the-dna-hash). |
| `membrane_proof.enabled` | boolean | false | Enable server-signed membrane proofs |
| `membrane_proof.signing_key_path` | string | — | Path to 64-char hex seed file. If absent, an ephemeral key is used. The public key derived from this seed **must match the progenitor embedded in the DNA**. |
| `email.provider` | `"postmark"` \| `"sendgrid"` \| `"file"` | — | Required for `email_code` auth |
| `email.api_key` | string | — | Postmark or SendGrid API token |
| `email.from` | string | — | Sender address |
| `email.template` | string | — | Custom email template |
| `email.output_dir` | string | `./dev-emails` | Directory for file transport output |
| `invite_codes` | string[] | — | Valid invite codes (for `invite_code` auth) |
| `allowed_agents` | string[] | — | Agent public keys (for `agent_allow_list` auth) |
| `session.store` | `"memory"` \| `"sqlite"` \| `"cloudflare-kv"` | `"memory"` | |
| `session.db_path` | string | `./sessions.db` | SQLite path (sqlite store only) |
| `session.pending_ttl_seconds` | number | 86400 | TTL for pending (unapproved) sessions. Ready sessions never expire — for memory/SQLite stores this means unbounded growth over time. At high scale, consider periodic pruning of old ready sessions or switching to Cloudflare KV with its built-in expiration. |
| `reconnect.enabled` | boolean | true | Allow `POST /v1/reconnect` |
| `reconnect.timestamp_tolerance_seconds` | number | 300 | Max clock drift (seconds) for reconnect signature |
| `base_url` | string | auto-detected | Override for `/.well-known/holo-joining` response |
| `port` | number | 3000 | |
| `network.bootstrap_url` | string | — | Bootstrap server URL (returned in provision response `network_config`) |
| `network.relay_url` | string | — | Relay server URL (returned in provision response `network_config`) |
| `network.reveal_in_info` | boolean | false | Include `network_config` in the public `/v1/info` response. **Security note**: enabling this exposes service URLs to unauthenticated callers, which may increase DDoS surface. |
| `hc_auth.url` | string | — | Base URL of hc-auth-server (e.g. `https://auth.example.com`). Also used as `auth_server_url` in provision response `network_config`. |
| `hc_auth.api_token` | string | — | Bearer token from the server's `API_TOKENS` env var |
| `hc_auth.required` | boolean | false | Block provisioning/reconnect if hc-auth is unreachable |
| `agent_registration.admin_secret` | string | — | Bearer token for the allowed-agent admin routes. If absent, admin routes return 404. When present, enables `POST/GET/DELETE /v1/admin/allowed-agents` for runtime registration of agents. |
| `network_registration.admin_secret` | string | — | Bearer token for the network admin routes. If absent, admin routes return 404. When present, enables `POST/GET/DELETE /v1/admin/networks` for runtime registration of networks. |
| `linker_auth` | LinkerAuthConfig | — | Linker authentication configuration |
| `delegated_verification` | DelegatedVerificationConfig | — | Configuration for delegated verification auth method |

### Registering allowed agents at runtime

When `agent_registration.admin_secret` is configured, operator pipelines can register progenitor agents without restarting the server. This matters when a network is spun up by a deployment pipeline: the progenitor's agent key is generated during provisioning, so it cannot be baked into the service config ahead of time.

```bash
curl -X POST https://join.example.com/v1/admin/allowed-agents \
  -H "Authorization: Bearer $JOINING_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent_key": "uhCAk...", "label": "acme-net progenitor"}'
```

Response:
```json
{
  "agent_key": "uhCAk...",
  "label": "acme-net progenitor",
  "registered_at": "2026-02-24T12:00:00Z"
}
```

Re-posting an already-registered `agent_key` updates its label and returns `200 OK`; `registered_at` keeps the first registration's timestamp. Unregister the agent first if you want it reset.

Registered agents are persisted using the same backend as `session.store`: `memory` agents are ephemeral and lost on restart; `sqlite` agents are written to `allowed-agents.db` alongside the sessions database. On Workers, this works out of the box: the bundled worker entry constructs a `KvAllowedAgentStore` against the `SESSIONS` KV binding whenever `agent_allow_list` is in `auth_methods` or `agent_registration` is configured.

Registrations only affect who can join when `agent_allow_list` is present in `auth_methods` — if `agent_registration.admin_secret` is set without it, the server logs a startup warning that registrations will have no effect on joins. Note also that `allowed-agents.db` is created on `sqlite` deployments whenever `agent_allow_list` is configured in `auth_methods`, even without `agent_registration` — the static `allowed_agents` list uses the same store.

### Registering networks at runtime

When `network_registration.admin_secret` is configured, operator pipelines can register networks without restarting the server. This enables dynamic network provisioning: a deployment pipeline spins up a network, registers it with the joining service in a single API call, and the progenitor can immediately join. A network's identity is its `happ_id` -- the same identity space as a conductor installed-app id -- not a separate slug.

Registering the progenitor in `allowed_agents` is what makes this safe on a service configured with `open` or `email_code` auth: a non-empty `allowed_agents` restricts joining that network to the listed agents (any other agent naming the network gets 403 `join_rejected`), on top of whatever `auth_methods` the service otherwise requires. Leaving `allowed_agents` absent or empty means the network is unrestricted -- any agent that satisfies `auth_methods` may join it, which is appropriate for networks meant to be publicly joinable.

```bash
curl -X POST https://join.example.com/v1/admin/networks \
  -H "Authorization: Bearer $JOINING_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "happ_id": "acme-network",
    "happ": { "name": "ACME staging environment" },
    "roles": {
      "main": {
        "dna_hash": "uhC0k...",
        "modifiers": {
          "network_seed": "acme-network-2026"
        }
      }
    },
    "allowed_agents": ["uhCAk...progenitor..."]
  }'
```

Response:
```json
{
  "happ_id": "acme-network",
  "happ": { "name": "ACME staging environment" },
  "roles": { "main": { "dna_hash": "uhC0k...", "modifiers": { "network_seed": "acme-network-2026" } } },
  "allowed_agents": ["uhCAk..."],
  "registered_at": "2026-02-24T12:00:00Z"
}
```

The progenitor can now join immediately with the registered network:

```bash
curl -X POST https://join.example.com/v1/join \
  -H "Content-Type: application/json" \
  -d '{
    "agent_key": "uhCAk...progenitor...",
    "network": "acme-network"
  }'
```

Registered networks are persisted using the same backend as `session.store`: `memory` networks are ephemeral and lost on restart; `sqlite` networks are written to `networks.db` alongside the sessions database. On Workers, this works out of the box: the bundled worker entry constructs a `KvNetworkStore` against the `SESSIONS` KV binding whenever `network_registration` is configured. A network's `dna_hash`es must be unique across every registered network and the service's own static `roles` -- registering a duplicate is rejected with 409 `duplicate_dna_hash` (see JOINING_SERVICE_API.md Section 3.11).

A service can also run **dynamic-only**: configure `network_registration` without any static `roles` in config, and the service has no roles of its own until networks are registered at runtime. Joins that omit `network` (or every network registration that gets deleted later) still succeed and provision linker/gateway URLs with no `roles` -- useful for operators who want every network onboarded through the admin API rather than baked into the service's config file.

---

## hc-auth-server integration

The joining service can integrate with [hc-auth-server](../hc-auth-server) in two modes: **notification** (joining service is the auth authority) or **approval** (hc-auth is the auth authority).

### Notification mode (existing behavior)

The joining service runs its own auth (email, invite code, allow list, etc.) and notifies hc-auth after approval. The agent is automatically registered and authorized in hc-auth when the session reaches `ready`.

```json
{
  "auth_methods": ["email_code"],
  "email": { "provider": "postmark", "api_key": "...", "from": "join@example.com" },
  "hc_auth": {
    "url": "https://auth.example.com",
    "api_token": "your-bearer-token"
  }
}
```

If hc-auth is unreachable, joining proceeds normally (unless `required: true`). The agent may fail to authenticate with the bootstrap server later, but the join itself is not blocked.

### Approval mode

Use `hc_auth_approval` as an auth method to delegate the approval decision to hc-auth. The agent is registered as `pending` in hc-auth at join time. The client polls `GET /status` until an operator approves (or blocks) the agent via the hc-auth ops console or an external KYC provider calls `/api/transition`.

```json
{
  "auth_methods": ["hc_auth_approval"],
  "hc_auth": {
    "url": "https://auth.example.com",
    "api_token": "your-bearer-token",
    "required": true
  }
}
```

The flow:

1. Client calls `POST /v1/join` with agent key
2. Joining service registers agent as `pending` in hc-auth and returns a pending session
3. Client polls `GET /v1/join/{session}/status`
4. Operator approves via hc-auth ops console, or external system calls `POST /api/transition`
5. Next status poll detects `authorized` in hc-auth, transitions session to `ready`
6. Client calls `GET /provision` for membrane proofs and linker URLs

Approval mode composes with other auth methods via AND/OR groups. For example, require email verification AND operator approval:

```json
{
  "auth_methods": ["email_code", "hc_auth_approval"],
  "email": { "provider": "postmark", "api_key": "...", "from": "join@example.com" },
  "hc_auth": {
    "url": "https://auth.example.com",
    "api_token": "your-bearer-token",
    "required": true
  }
}
```

Both challenges must complete before the session reaches `ready`.

### Revocation behavior

When `hc_auth_approval` is used, the joining service checks hc-auth state on every call to `/status`, `/provision`, and `/reconnect`. If the agent has been `blocked` in hc-auth:

- `/status` returns `rejected` with reason `"Agent blocked by administrator"`
- `/provision` returns 403 with error code `agent_revoked`
- `/reconnect` returns 403 with error code `agent_revoked`

When hc-auth is configured (even without `hc_auth_approval`), `/reconnect` also checks hc-auth state to prevent revoked agents from obtaining fresh linker URLs.

### Prerequisites

- A running hc-auth-server instance (see [hc-auth-server](../hc-auth-server) for setup)
- The `api_token` must match a value in the server's `API_TOKENS` environment variable
- For manual approval: the hc-auth ops console requires GitHub OAuth configuration

---

## Network config

The joining service can return network service URLs (bootstrap server, relay server, auth server) in the provision response. This allows conductor runtime to discover infrastructure URLs at join time rather than requiring them to be hardcoded. The runtime can then call `/now` on the auth server to obtain necessary infromate to generate `auth_material` for the conductor config.

### Configuration

```json
{
  "network": {
    "bootstrap_url": "https://bootstrap.holo.host",
    "relay_url": "wss://relay.holo.host"
  },
  "hc_auth": {
    "url": "https://auth.holo.host",
    "api_token": "your-bearer-token"
  }
}
```

The `auth_server_url` in the response is always derived from `hc_auth.url` -- there is no separate config field. If `hc_auth` is not configured, `auth_server_url` is omitted. Each field in `network_config` is independently optional; the entire object is omitted from the response when no URLs are available.

### Provision response

After a successful join, `GET /v1/join/{session}/provision` returns:

```json
{
  "linker_urls": [...],
  "network_config": {
    "auth_server_url": "https://auth.holo.host",
    "bootstrap_url": "https://bootstrap.holo.host",
    "relay_url": "wss://relay.holo.host"
  }
}
```

### Exposing network_config in /v1/info

By default, `network_config` is **not** included in the unauthenticated `/v1/info` endpoint. This is a security consideration: exposing infrastructure URLs publicly increases their DDoS surface.

To enable it (e.g., for development or when the URLs are already public):

```json
{
  "network": {
    "bootstrap_url": "https://bootstrap.holo.host",
    "relay_url": "wss://relay.holo.host",
    "reveal_in_info": true
  }
}
```

---

## 2. Cloudflare Workers

The app is built on Hono, which runs natively in the Workers runtime. Sessions are stored in Cloudflare KV.

### Prerequisites

- Cloudflare account with Workers and KV enabled
- Wrangler CLI: `npm install -g wrangler`
- `wrangler login`

### Create KV namespaces

```sh
wrangler kv namespace create SESSIONS
wrangler kv namespace create SESSIONS --preview
```

Note the namespace IDs printed; you will use them in `wrangler.toml`.

### wrangler.toml

Create `wrangler.toml` in the project root:

```toml
name = "joining-service"
main = "src/worker.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "SESSIONS"
id = "<your-production-kv-id>"
preview_id = "<your-preview-kv-id>"

# CONFIG_JSON is set as a secret (see below), not a var.
# Linker registrations are stored in the SESSIONS KV namespace.
```

Secrets:

```sh
# Full service config as JSON:
echo '{"happ":{"id":"my-happ","name":"My hApp"},"auth_methods":["open"]}' | wrangler secret put CONFIG_JSON
# The 64-char hex seed from gen-signing-key.mjs (if using membrane proofs):
wrangler secret put SIGNING_KEY_HEX
```

The `SIGNING_KEY_HEX` secret must be the hex seed whose derived public key matches the progenitor embedded in your DNA. See the [membrane proof section](#membrane-proof-signing-key-and-dna-progenitor).

Linker registrations are stored in the KV namespace (written via `wrangler kv key put` or the deploy script's `seed-kv` command).

### Worker entry point

The actual worker entry point is at `deploy/cloudflare/worker-entry.ts`. It reads a `CONFIG_JSON` secret (the full config as JSON) and uses `KvUrlProvider` for linker URLs stored in the SESSIONS KV namespace. See that file for the production implementation.

Below is a simplified example for reference:

```typescript
import { createApp, resolveConfig } from './index.js';
import { KvSessionStore } from './session/kv-store.js';
import { OpenAuthMethod } from './auth-methods/open.js';

interface Env {
  SESSIONS: KVNamespace;
  CONFIG_JSON: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const configInput = JSON.parse(env.CONFIG_JSON);
    const config = resolveConfig(configInput);
    const sessionStore = new KvSessionStore(
      env.SESSIONS,
      config.session?.pending_ttl_seconds,
    );

    const authPlugins = new Map();
    authPlugins.set('open', new OpenAuthMethod());

    const app = createApp({ config, sessionStore, authPlugins });
    return app.fetch(request);
  },
};
```

### Deploy

```sh
# Preview (local Miniflare emulation)
wrangler dev

# Production deploy
wrangler deploy
```

### Custom domain

In the Cloudflare dashboard: Workers & Pages → your worker → Settings → Domains & Routes → add a custom domain or route pattern.

Or via `wrangler.toml`:

```toml
[[routes]]
pattern = "joining.example.com/*"
zone_name = "example.com"
```

### Workers-specific constraints

- **No filesystem.** `membrane_proof.signing_key_path` is not available; pass the hex seed as the `MEMBRANE_PROOF_SIGNING_KEY` secret instead.
- **No SQLite.** Use `session.store: "cloudflare-kv"`.
- **KV consistency.** KV is eventually consistent. Under high concurrent join load, two requests for the same agent key may race and create duplicate pending sessions. This is harmless: one will be overwritten. Ready sessions are not affected.
- **Dynamic registration works out of the box.** Allowed-agent, network, and linker admin routes (`/v1/admin/allowed-agents`, `/v1/admin/networks`, `/v1/admin/linkers`) are all backed by the `SESSIONS` KV binding as soon as their corresponding config secrets (`agent_registration.admin_secret`, `network_registration.admin_secret`, `linker_auth.admin_secret`) are set -- no extra wiring is needed. Dynamic linker registration is Workers-only: Node deployments have no KV backend for it (see below).

---

## 3. Edge node (self-hosted Linux VPS)

Standard Node.js deployment behind a reverse proxy.

### Prerequisites

- Node.js 20+
- Process supervisor (systemd)
- nginx or Caddy for TLS termination

### Build

```sh
npm install
npm run build
```

Output goes to `dist/`.

### Configuration file

Use the same JSON format as the local setup. For production:

- `session.store: "sqlite"` with a durable `db_path` (not in `/tmp`)
- `email.provider: "postmark"` with a real API key
- `membrane_proof.signing_key_path` pointing to a persistent file

The `signing_key_path` file must contain the same hex seed used to derive the progenitor key that was embedded in the DNA when the hApp bundle was compiled. See the [membrane proof section](#membrane-proof-signing-key-and-dna-progenitor).

Example `/etc/joining-service/config.json`:

```json
{
  "happ": {
    "id": "my-happ",
    "name": "My hApp",
    "happ_bundle_url": "https://app.example.com/my-happ.happ"
  },
  "auth_methods": ["email_code"],
  "linker_registrations": [{"linker_url": {"url": "wss://linker.example.com:8090"}}],
  "http_gateways": [
    {
      "url": "https://gw.example.com",
      "dna_hashes": ["uhC0k..."],
      "status": "available"
    }
  ],
  "roles": {
    "main": {
      "dna_hash": "uhC0k...",
      "modifiers": {
        "network_seed": "my-happ-mainnet-2026"
      }
    }
  },
  "membrane_proof": {
    "enabled": true,
    "signing_key_path": "/etc/joining-service/signing-key.hex"
  },
  "email": {
    "provider": "postmark",
    "api_key": "YOUR_POSTMARK_TOKEN",
    "from": "join@example.com"
  },
  "session": {
    "store": "sqlite",
    "db_path": "/var/lib/joining-service/sessions.db"
  },
  "base_url": "https://joining.example.com/v1",
  "port": 3000
}
```

### Dynamic linker registration

Allowed-agent and network registration (`agent_registration`, `network_registration`) work on Node out of the box, backed by `sqlite` or `memory` per `session.store`. Dynamic *linker* registration does not: `LinkerRegistrationStore` is constructed against a KV-namespace-shaped store, and no Node (sqlite/memory) implementation of that shape ships -- only Cloudflare Workers KV satisfies it out of the box. Running dynamic linker registration on Node requires embedding the service as a library (`import { createApp, ... } from '@holo-host/joining-service'`) and supplying your own `linkerRegistrationStore` in the `ServiceContext`.

### Install the signing key file

The key was generated in the [membrane proof section](#membrane-proof-signing-key-and-dna-progenitor). Copy it to the server securely:

```sh
# Copy from your secrets manager or local machine
echo "<64-char-hex-seed>" > /etc/joining-service/signing-key.hex
chmod 600 /etc/joining-service/signing-key.hex
chown joining-service:joining-service /etc/joining-service/signing-key.hex
```

Do not regenerate this key on the server — use the same key that was embedded in the compiled DNA.

### systemd unit

`/etc/systemd/system/joining-service.service`:

```ini
[Unit]
Description=Holo Joining Service
After=network.target

[Service]
Type=simple
User=joining-service
Group=joining-service
WorkingDirectory=/opt/joining-service
ExecStart=/usr/bin/node dist/server.js /etc/joining-service/config.json
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/joining-service /etc/joining-service

[Install]
WantedBy=multi-user.target
```

```sh
useradd --system --no-create-home joining-service
mkdir -p /var/lib/joining-service
chown joining-service:joining-service /var/lib/joining-service

# Install app files
mkdir -p /opt/joining-service
cp -r dist package.json /opt/joining-service/
cd /opt/joining-service && npm install --omit=dev

systemctl daemon-reload
systemctl enable --now joining-service
systemctl status joining-service
```

### nginx reverse proxy with TLS

`/etc/nginx/sites-available/joining-service`:

```nginx
server {
    listen 443 ssl http2;
    server_name joining.example.com;

    ssl_certificate     /etc/letsencrypt/live/joining.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/joining.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name joining.example.com;
    return 301 https://$host$request_uri;
}
```

```sh
ln -s /etc/nginx/sites-available/joining-service /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d joining.example.com
```

### Deploying the `.well-known` discovery endpoint

The `/.well-known/holo-joining` endpoint must be served from the **hApp UI domain** (the origin users load in their browser), not necessarily from the joining service domain. The simplest approach is a static JSON file on the app's web server.

nginx on the app domain:

```nginx
location = /.well-known/holo-joining {
    alias /var/www/app/.well-known/holo-joining.json;
    default_type application/json;
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "public, max-age=3600";
}
```

`/var/www/app/.well-known/holo-joining.json`:

```json
{
  "joining_service_url": "https://joining.example.com/v1",
  "happ_id": "my-happ",
  "version": "1.0"
}
```

If the joining service runs on the same domain as the hApp UI (same nginx vhost), the built-in `GET /.well-known/holo-joining` handler covers this without extra configuration.

### Headless node provisioning

For nodes without a UI (e.g. systemd-managed conductors), use `joining-cli` to run the join flow, generate roles-settings YAML, and handle hc-auth authentication from the command line. See [CLI.md](./CLI.md) for full usage.

### Verify the deployment

```sh
curl https://joining.example.com/.well-known/holo-joining
curl https://joining.example.com/v1/info
```

### Updates

```sh
npm run build
rsync -a dist/ server:/opt/joining-service/dist/
ssh server systemctl restart joining-service
```

---

## Signing key operational notes

### Key rotation

The signing key is baked into the compiled DNA. Changing the key requires:

1. Generating a new seed (see above)
2. Changing the progenitor in the DNA source
3. Rebuilding and redeploying the hApp bundle
4. Updating the joining service config to use the new seed

There is no in-place rotation. Agents who joined under the old DNA hash and membrane proof remain valid on the DHT (membrane proofs are committed at genesis and do not need re-validation). Agents joining after the new bundle is deployed will receive proofs signed by the new key, validated by the new DNA.

### Multiple deployment targets with the same DNA

If you deploy the joining service to both Cloudflare Workers and a VPS (e.g. active/passive failover), both deployments must use the **same seed hex** and must serve the same `linker_urls`. The DNA has one progenitor; both services sign proofs with the same key.

### Backing up the key

| Environment | Backup method |
|-------------|---------------|
| Edge node | Store seed hex in a secrets manager (Vault, AWS Secrets Manager, etc.) and/or encrypted offline backup |
| Cloudflare Workers | The Wrangler secret is stored by Cloudflare; export the hex seed from your secrets manager as the source of truth |
| Local dev | Ephemeral key — no backup needed |
