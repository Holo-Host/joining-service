# Holo Joining Service API Specification

**Version**: 1.0.0-draft
**Date**: 2026-03-05
**Status**: Design specification

## Overview

The Joining Service is a per-hApp REST API that brokers the onboarding flow for users of Holochain apps running in the Holo Web Conductor (HWC) browser extension. It centralizes the configuration that HWC clients need to participate in a Holochain network: linker URLs, optional membrane proofs, hApp bundle locations, and identity verification flows.

Each hApp developer runs their own joining service (or uses a hosted one). The HWC client library auto-discovers it via `.well-known/holo-joining` on the app domain.

### User Flow Summary

```
First-time join:
  1. User loads web page
  2. Extension auto-detected (or download prompted)
  3. Client discovers joining service via .well-known
  4. GET /v1/info → R/O gateway URLs (optional browse-before-join)
  5. Extension generates agent key
  6. POST /v1/join → session + challenges (if any)
  7. User completes verification challenges (if any)
  8. GET /v1/join/{session}/provision → linker URLs, membrane proof, hApp bundle URL
  9. Client installs hApp with provision data
  10. Standard hApp UI operates

Reconnect (linker URLs expired or infrastructure changed):
  11. POST /v1/reconnect { agent_key, timestamp, signature }
      → updated linker URLs, gateway URLs
  12. Client reconnects to new linker URLs

Recovery (joined, then crashed before installing):
  13. POST /v1/reconnect { agent_key, timestamp, signature, network }
      → session token, plus updated URLs
  14. GET /v1/join/{session}/provision → install as in step 9
```

---

## 1. Base URL and Versioning

The API is versioned via URL path prefix:

```
https://app.example.com/.well-known/holo-joining   (discovery)
https://joining.example.com/v1/info                 (API endpoints)
https://joining.example.com/v1/join                 (API endpoints)
```

The discovery endpoint returns the versioned base URL. Clients resolve it from `.well-known` and never hardcode the API path.

All responses include the header:
```
X-Joining-Service-Version: 1.0
```

---

## 2. Auto-Discovery

### `GET /.well-known/holo-joining`

Served from the **app domain** (the domain where the hApp UI is hosted). Returns a pointer to the joining service.

**Response** (`200 OK`):
```json
{
  "joining_service_url": "https://joining.example.com/v1",
  "happ_id": "mewsfeed",
  "version": "1.0"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `joining_service_url` | string (URL) | yes | Base URL for the joining service API (includes version prefix) |
| `happ_id` | string | yes | Identifier for this hApp (used for logging/routing, not cryptographic) |
| `version` | string | yes | Version of the well-known format (`"1.0"`) |

**Headers**:
- `Content-Type: application/json`
- `Access-Control-Allow-Origin: *`
- `Cache-Control: public, max-age=3600`

If the file does not exist, the client falls back to manual configuration (developer passes `linkerUrl` directly, as is done today).

The document's `happ_id` is also the identifier that routes discovery to the right network on a joining service that hosts more than one: a client passes it through as `network` on `POST /v1/join` (Section 3.2) and can look up its metadata at `GET /v1/info/:happ_id` (Section 3.1). The `.well-known` document format itself is unchanged -- it has always carried `happ_id`.

---

## 3. Endpoints

### 3.1 `GET /v1/info` — Service Info

Returns hApp metadata, available read-only gateways, supported auth methods, and linker information. **Unauthenticated** — anyone loading the page can call this.

**Note**: This bare endpoint describes only the service's statically configured network (the static `roles` in config). To discover any network -- including registered ones -- by id, use `GET /v1/info/:happ_id` below.

**Response** (`200 OK`):
```json
{
  "happ": {
    "id": "mewsfeed",
    "name": "Mewsfeed",
    "description": "Decentralized microblogging on Holochain",
    "icon_url": "https://app.example.com/icon.png"
  },
  "http_gateways": [
    {
      "url": "https://gw1.example.com",
      "dna_hashes": ["uhC0k..."],
      "status": "available"
    }
  ],
  "auth_methods": ["invite_code", { "any_of": ["email_code", "sms_code"] }],
  "linker_info": {
    "selection_mode": "assigned",
    "region_hints": ["us-east", "eu-west"]
  },
  "happ_bundle_url": "https://app.example.com/mewsfeed.happ",
  "roles": {
    "main": {
      "dna_modifiers": {
        "network_seed": "mewsfeed-mainnet-2026",
        "properties": {}
      }
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `happ.id` | string | yes | Machine-readable hApp identifier |
| `happ.name` | string | yes | Human-readable name |
| `happ.description` | string | no | Short description |
| `happ.icon_url` | string (URL) | no | Icon for display in extension popup |
| `http_gateways` | array | no | Available hc-http-gw instances for read-only access before joining |
| `http_gateways[].url` | string (URL) | yes | Gateway base URL |
| `http_gateways[].dna_hashes` | string[] | yes | Base64-encoded DNA hashes served by this gateway |
| `http_gateways[].status` | string | yes | `"available"`, `"degraded"`, or `"offline"` |
| `http_gateways[].expires_at` | string (ISO 8601) | no | When this gateway entry expires. Absent means no known expiry. |
| `auth_methods` | AuthMethodEntry[] | yes | Supported authentication methods (see Section 8). Each entry is either an `AuthMethod` string or an `{ any_of: AuthMethod[] }` group. Top-level entries are AND'd; methods within an `any_of` group are OR'd. |
| `linker_info` | object | no | Absent when the service does not manage linker relay URLs (e.g. pure membrane-proof or gateway-only deployments) |
| `linker_info.selection_mode` | string | if linker_info present | `"assigned"` (server picks linker) or `"client_choice"` (client picks from list) |
| `linker_info.region_hints` | string[] | no | Available regions for latency optimization |
| `happ_bundle_url` | string (URL) | no | URL to download the .happ bundle. May be absent if gated behind auth. |
| `roles` | object | no | Per-role DNA modifiers. Role name → `{ dna_modifiers? }`. Present whenever the service config declares `roles`. |
| `roles[role_name].dna_modifiers` | object | no | DNA modifiers for this role (network_seed, properties, etc.) |
| `network_config` | object | no | Network service URLs. Only present when `network.reveal_in_info` is enabled in config (default: off). Exposing these URLs publicly may increase DDoS surface area for the listed services. |
| `network_config.auth_server_url` | string (URL) | no | HC-Auth server URL (derived from `hc_auth.url` config) |
| `network_config.bootstrap_url` | string (URL) | no | Bootstrap server URL |
| `network_config.relay_url` | string (URL) | no | Relay server URL |

**`GET /v1/info/:happ_id`** — Same response shape, scoped to a specific network. **Unauthenticated**, mounted next to the bare endpoint above.

- If `:happ_id` equals the service's own statically configured happ id (`happ.id` in config), the response is identical to the bare `GET /v1/info` above -- it's an alias, not a second network.
- If `:happ_id` names a network registered via `POST /v1/admin/networks` (Section 3.11), the response uses that network's own data: `happ.name` falls back to `happ_id` when the registration didn't set `happ.name`; `happ.description`/`happ.icon_url` come from the registration's `happ` object (absent if unset); `happ_bundle_url` comes only from the registration's `happ.happ_bundle_url` (no fallback to the service's own `happ_bundle_url`); `roles` reflects that network's own roles. `http_gateways`, `auth_methods`, `linker_info`, and `network_config` are service-wide and identical to the bare endpoint's, since they don't vary per network.
- **Gated networks omit `roles`**: if the network has a non-empty `allowed_agents` (Section 3.11), `roles` is absent from this response, even though `happ` and the service-level fields are still served. An `allowed_agents` gate restricts *joining*, not visibility of an unauthenticated endpoint -- exposing the role modifiers (e.g. `network_seed`) to anyone who knows or guesses the `happ_id` would leak them regardless of the gate. Agents that clear the gate still receive `roles`/membrane proofs normally at `GET /v1/join/{session}/provision` (Section 3.5).
- If `:happ_id` is neither the static happ id nor a registered network, the response is `404 unknown_network`.

**Response** (`200 OK`) — `GET /v1/info/acme-net` for a registered, ungated network:
```json
{
  "happ": {
    "id": "acme-net",
    "name": "Acme",
    "description": "Acme's pipeline-provisioned network"
  },
  "http_gateways": [
    {
      "url": "https://gw1.example.com",
      "dna_hashes": ["uhC0k..."],
      "status": "available"
    }
  ],
  "auth_methods": ["agent_allow_list"],
  "happ_bundle_url": "https://releases.acme.example/acme.happ",
  "roles": {
    "main": {
      "dna_modifiers": {
        "network_seed": "acme-mainnet-2026",
        "properties": {}
      }
    }
  }
}
```

`happ_bundle_url` and `roles` are the registration's own; `http_gateways` and `auth_methods` are the same service-wide values the bare endpoint returns. For a gated network the same response omits `roles`.

---

### 3.2 `POST /v1/join` — Initiate Join

The client sends its agent key and optional identity claims. The server determines what verification (if any) is required.

**Request**:
```json
{
  "agent_key": "uhCAk...",
  "network": "my-network",
  "claims": {
    "email": "user@example.com"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_key` | string | yes | Base64-encoded 39-byte AgentPubKey (from `encodeHashToBase64()`) |
| `claims` | object | no | Identity claims for verification |
| `claims.email` | string | no | Email address |
| `claims.phone` | string | no | Phone number (E.164 format) |
| `claims.evm_address` | string | no | EVM wallet address (0x-prefixed, checksummed) |
| `claims.solana_address` | string | no | Solana wallet address (base58) |
| `claims.invite_code` | string | no | Pre-issued invite code |
| `network` | string | no | `happ_id` of a registered network (see Section 3.11 for registration), or the service's own statically configured happ id (`happ.id` in config). Naming the statically configured happ id is treated exactly as omitting `network` -- both land the session in the same scope and receive the service's static `roles` at provision. If present but not a string, not matching the happ_id format, or not registered with the service (and not the static happ id), the join is rejected with 400 `unknown_network`. If the named network has a non-empty `allowed_agents` and `agent_key` is not in it, the join is rejected with 403 `join_rejected` -- see Section 3.11. |

**Response** (`201 Created`) — verification required:
```json
{
  "session": "js_a1b2c3d4e5f6",
  "status": "pending",
  "challenges": [
    {
      "id": "ch_email_1",
      "type": "email_code",
      "description": "Enter the 6-digit code sent to u***@example.com",
      "expires_at": "2026-02-24T12:30:00Z",
      "group": "g_0"
    },
    {
      "id": "ch_sms_1",
      "type": "sms_code",
      "description": "Enter the 6-digit code sent to +1***4567",
      "expires_at": "2026-02-24T12:30:00Z",
      "group": "g_0"
    }
  ],
  "poll_interval_ms": 2000
}
```

**Response** (`201 Created`) — open join, ready immediately:
```json
{
  "session": "js_x9y8z7w6",
  "status": "ready"
}
```

**Response** (`403 Forbidden`) — rejected (see Errors below):
```json
{
  "error": {
    "code": "join_rejected",
    "message": "This hApp requires an invite code"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Opaque session token (prefixed `js_`) |
| `status` | string | yes | `"ready"` or `"pending"` |
| `challenges` | array | if pending | Verification challenges to complete |
| `challenges[].id` | string | yes | Challenge identifier (used in verify endpoint) |
| `challenges[].type` | string | yes | Challenge type (matches `auth_methods` values) |
| `challenges[].description` | string | yes | Human-readable instruction for the user |
| `challenges[].expires_at` | string (ISO 8601) | no | When this challenge expires |
| `challenges[].metadata` | object | no | Type-specific data (e.g., EVM signing payload, nonce for agent_allow_list) |
| `challenges[].group` | string | no | OR group identifier. Challenges sharing the same group are alternatives -- completing any one satisfies the group. |
| `poll_interval_ms` | number | if pending | Suggested polling interval in milliseconds |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_agent_key` | Agent key is not valid base64 or not 39 bytes |
| 400 | `unknown_network` | `network` value is not a string, does not match the network-id format, or names a network not registered with this service |
| 400 | `missing_claims` | Required claims for this hApp's auth method were not provided |
| 403 | `join_rejected` | Join was rejected (agent not on the named network's `allowed_agents`, agent not eligible, invalid invite code, no satisfiable auth method). Nothing was created; the response body is the standard error shape with the reason in `error.message`. |
| 409 | `agent_already_joined` | This agent key has already completed joining this network. Use `POST /v1/reconnect` instead. |
| 429 | `rate_limited` | Too many join attempts |

An agent key can hold at most one live session per network: joining is scoped to the agent-key-plus-network pair (an omitted `network`, and the statically configured network's own happ id, are the same scope -- see Section 3.2). An agent that already joined one network may join a different network -- that second join is a separate session with its own roles at provision time. Re-joining a network the agent already has a live session on gets `409 agent_already_joined`; there is no re-join within the same network. `POST /v1/reconnect` (Section 3.6) refreshes linker/gateway URLs for an agent with any ready session, regardless of which network it named, and separately returns a network-scoped `session` token when the requested network has a ready session -- that token is for the same `GET /v1/join/{session}/provision` (Section 3.5) call the original join would have used, which is how an agent that crashed between receiving its session token and provisioning recovers without a second join.

---

### 3.3 `POST /v1/join/{session}/verify` — Submit Verification

Submit verification responses for pending challenges.

**Request**:
```json
{
  "challenge_id": "ch_email_1",
  "response": "482916"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `challenge_id` | string | yes | Challenge ID from the join response |
| `response` | string | yes | Verification response (code, signature, etc.) |

For EVM signature challenges, `response` is the hex-encoded signature:
```json
{
  "challenge_id": "ch_evm_1",
  "response": "0x1234abcd..."
}
```

**Response** (`200 OK`) — challenge passed, more remain:
```json
{
  "status": "pending",
  "challenges_remaining": [
    {
      "id": "ch_sms_1",
      "type": "sms_code",
      "description": "Enter the 6-digit code sent to +1***4567",
      "expires_at": "2026-02-24T12:35:00Z"
    }
  ],
  "poll_interval_ms": 2000
}
```

**Response** (`200 OK`) — all challenges complete:
```json
{
  "status": "ready"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | yes | `"ready"`, `"pending"`, or `"rejected"` |
| `challenges_remaining` | array | if pending | Remaining challenges |
| `reason` | string | if rejected | Rejection reason (e.g., wrong code too many times) |
| `poll_interval_ms` | number | if pending | Suggested polling interval |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_response` | Response format is wrong for this challenge type |
| 401 | `invalid_session` | Session token is invalid or expired |
| 404 | `challenge_not_found` | Challenge ID not found for this session |
| 410 | `challenge_expired` | Challenge has expired; client should `POST /join` again |
| 422 | `verification_failed` | Response was incorrect (e.g., wrong code) |
| 429 | `rate_limited` | Too many verification attempts |

---

### 3.4 `GET /v1/join/{session}/status` — Poll Status

Poll for the current status of a join session. Used when external processes (e.g., admin approval, async KYC) may change the status without client action.

**Response** (`200 OK`):
```json
{
  "status": "pending",
  "challenges": [
    {
      "id": "ch_email_1",
      "type": "email_code",
      "description": "Enter the 6-digit code sent to u***@example.com",
      "completed": false
    }
  ],
  "poll_interval_ms": 2000
}
```

The `/status` endpoint returns the current session state, including status and optional challenges, rejection reason, or polling guidance.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | yes | `"ready"`, `"pending"`, or `"rejected"` |
| `challenges` | array | if pending | Remaining challenges with per-challenge `completed` flag (same shape as `/join` response) |
| `reason` | string | if rejected | Human-readable rejection reason (e.g. `"agent blocked by administrator"`) |
| `poll_interval_ms` | number | if pending | Suggested polling interval in milliseconds |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `invalid_session` | Session token is invalid or expired |
| 410 | `session_expired` | Session has expired entirely |

---

### 3.5 `GET /v1/join/{session}/provision` — Get Provision

Retrieve the provision data needed to connect to the Holochain network. Only available when session status is `"ready"`. The `roles` and `happ_bundle_url` fields are populated from the named network's registration (if a `network` was specified at join time) -- `happ_bundle_url` comes only from that registration's `happ.happ_bundle_url`, with no fallback to the service's own, so it is absent if the registration didn't set one. A session with no named network uses the service's static `roles` and `happ.happ_bundle_url` configuration. `network_config` (bootstrap/relay/auth-server URLs) is not part of a network registration -- it comes from the service's own config and is the same for every session regardless of which `network` was joined.

**Response** (`200 OK`):
```json
{
  "linker_urls": [
    { "url": "wss://linker1.example.com:8090" },
    { "url": "wss://linker2.example.com:8090", "expires_at": "2026-02-25T18:00:00Z" }
  ],
  "roles": {
    "chat": {
      "membrane_proof": "gqNPa6RkYXRh...",
      "dna_modifiers": {
        "network_seed": "mewsfeed-mainnet-2026",
        "properties": { "app_name": "mewsfeed" }
      }
    },
    "profiles": {
      "membrane_proof": "hRtYm9keW..."
    }
  },
  "happ_bundle_url": "https://app.example.com/mewsfeed.happ",
  "network_config": {
    "auth_server_url": "https://auth.example.com",
    "bootstrap_url": "https://bootstrap.example.com",
    "relay_url": "wss://relay.example.com"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `linker_urls` | LinkerUrl[] | no | Ordered list of linker URL entries (client tries in order). Absent when the service does not manage linker relay URLs. |
| `linker_urls[].url` | string (WSS URL) | yes | WebSocket URL for this linker relay |
| `linker_urls[].expires_at` | string (ISO 8601) | no | When this individual linker URL reservation expires. Absent means no known expiry. Client should call `POST /v1/reconnect` to obtain fresh URLs. Membrane proofs do not expire. |
| `roles` | object | no | Per-role provision data. Role name → `{ membrane_proof?, dna_modifiers? }`. Mirrors `hc s call install-app --roles-settings` during app installation. See `RoleProvision` type. |
| `roles[role_name].membrane_proof` | string | no | Base64-encoded msgpack membrane proof for this role's DNA. One entry per role that requires a membrane proof. |
| `roles[role_name].dna_modifiers` | object | no | DNA modifiers for this role (network_seed, properties, etc.) |
| `happ_bundle_url` | string (URL) | no | URL to fetch the .happ bundle: the named network's own `happ.happ_bundle_url` if a `network` was joined (no fallback to the service's), otherwise the service's static `happ.happ_bundle_url`. |
| `network_config` | object | no | Network service URLs for conductor configuration. Only present when at least one URL is available. |
| `network_config.auth_server_url` | string (URL) | no | HC-Auth server URL (derived from `hc_auth.url` config). The conductor runtime can call `/now` on this to obtain info for `auth_material`. |
| `network_config.bootstrap_url` | string (URL) | no | Bootstrap server URL |
| `network_config.relay_url` | string (URL) | no | Relay server URL |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `invalid_session` | Session token is invalid or expired |
| 403 | `not_ready` | Session exists but status is not `"ready"` |
| 403 | `agent_revoked` | Agent was blocked by administrator (hc_auth_approval revocation) |
| 404 | `unknown_network` | Network named at join time was deleted before provisioning |
| 410 | `session_expired` | Session has expired; must start over |

---

### 3.6 `POST /v1/reconnect` — Reconnect (Get Updated URLs)

An agent that has already completed joining can request updated linker URLs and gateway URLs, and recover the session token for a network it has a ready session on. This is used when:
- One or more linker URL reservations have expired (per-entry `expires_at` has passed)
- The client has lost connectivity and needs fresh infrastructure URLs
- The pool of available linkers or gateways has changed
- The client completed `POST /v1/join` and received a session token, then crashed or lost the token before calling `GET /v1/join/{session}/provision` -- reconnect is how it gets back a session token to provision with, without a second join (which would 409)

This endpoint does **not** re-run verification challenges. Instead, the agent proves key ownership by signing a timestamp with their ed25519 private key.

**Request**:
```json
{
  "agent_key": "uhCAk...",
  "timestamp": "2026-02-25T12:00:00Z",
  "signature": "base64-encoded-ed25519-signature-of-timestamp",
  "network": "my-network"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_key` | string | yes | Base64-encoded 39-byte AgentPubKey (same key used during join) |
| `timestamp` | string (ISO 8601) | yes | Current UTC timestamp. Server rejects if more than 5 minutes from server time. |
| `signature` | string | yes | Base64-encoded ed25519 signature of the exact `timestamp` string, signed with the private key corresponding to `agent_key`. The signature covers only `timestamp` -- `network` selects among the agent's own already-authenticated sessions and does not need to be signed over. |
| `network` | string | no | `happ_id` of the network whose session token to look up (same value as sent to `POST /v1/join`). Omitted, or equal to the service's own statically configured happ id, targets the static network -- both spellings are the same scope, as in Section 3.2. If present but not a string, or not matching the happ_id format, the request is rejected with 400 `unknown_network` rather than falling back to the static scope. |

The linker/gateway URL refresh and the session-token lookup are checked separately:

- **URL refresh** works as soon as the agent has *any* ready session on the service, regardless of which network (or no network) that session named -- linker/gateway URLs are service-wide, not per-network. This gate is what `403 agent_not_joined` below reports.
- **Session-token lookup** is scoped to the requested network (static network if `network` was omitted):
  - A ready session there → response includes `session`.
  - `network` was explicitly given and names a network other than the statically configured one, and there's no ready session there → `403 agent_not_joined`, naming that network, instead of a 200 with no `session`. This is the caller's signal to `POST /v1/join` that network instead.
  - `network` was omitted, or explicitly given as the statically configured happ id (the two are the same scope), and the static network has no ready session → `session` is simply absent from an otherwise-normal `200` response; this is not an error (an agent whose only session names a non-static network still gets its URL refresh).

**Response** (`200 OK`):
```json
{
  "linker_urls": [
    { "url": "wss://linker3.example.com:8090", "expires_at": "2026-02-25T18:00:00Z" },
    { "url": "wss://linker4.example.com:8090" }
  ],
  "http_gateways": [
    {
      "url": "https://gw2.example.com",
      "dna_hashes": ["uhC0k..."],
      "status": "available"
    }
  ],
  "session": "js_a1b2c3d4e5f6"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `linker_urls` | LinkerUrl[] | no | Updated ordered list of linker URL entries. Absent when the service does not manage linker relay URLs. Each entry may carry its own `expires_at`. |
| `http_gateways` | array | no | Current read-only gateway instances (same schema as `/v1/info`). Each entry may carry its own `expires_at`. |
| `session` | string | no | Session token for the requested network's ready session (see the three-case behavior above). Pass it to `GET /v1/join/{session}/provision` (Section 3.5) exactly as with a fresh join. Absent when the requested scope has no ready session and `network` was omitted. |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_agent_key` | Agent key is not valid base64 or not 39 bytes |
| 400 | `invalid_signature` | Signature does not verify against agent key |
| 400 | `timestamp_out_of_range` | Timestamp is more than 5 minutes from server time |
| 400 | `unknown_network` | `network` is present but not a string, or does not match the network-id format |
| 403 | `agent_not_joined` | This agent key has no ready session at all, or `network` was explicitly given as a network other than the static one and has no ready session there |
| 403 | `agent_revoked` | Agent was blocked by administrator (hc_auth_approval revocation) |
| 429 | `rate_limited` | Too many reconnect attempts |

---

### 3.7 `POST /v1/admin/allowed-agents` — Register Allowed Agent

Operator endpoint to register an agent key at runtime, enabling it to join via the `agent_allow_list` auth method. This complements the static `allowed_agents` config list — registered agents and config-listed agents are treated identically during join authorization.

Re-registering an existing `agent_key` replaces the record, including clearing a previously set `label` if none is supplied. The original `registered_at` is carried forward and the response is `200 OK` rather than `201 Created`. To reset `registered_at`, unregister the agent first.

**Authentication**: Bearer token via `Authorization` header. The token value must match the server's `agent_registration.admin_secret` config. Requests without the header return 401 `unauthorized`; requests with a wrong token return 403 `forbidden`.

**Request**:
```json
{
  "agent_key": "uhCAk...",
  "label": "acme-net progenitor"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_key` | string | yes | Base64-encoded 39-byte AgentPubKey (must be valid base64 and exactly 39 bytes) |
| `label` | string | no | Human-readable label for this agent (e.g., hApp name, operator name) |

**Response** (`201 Created` for a new agent, `200 OK` when updating an existing one):
```json
{
  "agent_key": "uhCAk...",
  "label": "acme-net progenitor",
  "registered_at": "2026-02-24T12:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agent_key` | string | The registered agent key |
| `label` | string | Label (if provided in request) |
| `registered_at` | string (ISO 8601) | Timestamp when the agent was **first** registered; unchanged by re-registration |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_agent_key` | Agent key is not valid base64 or not 39 bytes |
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Authorization header present but token does not match `agent_registration.admin_secret` |

---

### 3.8 `GET /v1/admin/allowed-agents` — List Allowed Agents

Retrieve all currently registered agents. This does **not** include agents from the static `allowed_agents` config list; it shows only runtime-registered agents.

**Authentication**: Bearer token (same as POST endpoint).

**Response** (`200 OK`):
```json
{
  "agents": [
    {
      "agent_key": "uhCAk...",
      "label": "acme-net progenitor",
      "registered_at": "2026-02-24T12:00:00Z"
    },
    {
      "agent_key": "uhCAk...",
      "label": "beta-net test agent",
      "registered_at": "2026-02-24T13:15:00Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agents` | array | List of registered agent objects |
| `agents[].agent_key` | string | Agent key |
| `agents[].label` | string | Label (if provided at registration) |
| `agents[].registered_at` | string (ISO 8601) | Registration timestamp |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Invalid token |

---

### 3.9 `DELETE /v1/admin/allowed-agents/:agent_key` — Unregister Allowed Agent

Remove an agent from the runtime-registered list. The agent will no longer be allowed to join via `agent_allow_list` auth (unless it is also in the static `allowed_agents` config).

Unregistering prevents future joins; it does not terminate in-flight join sessions or revoke agents that have already joined (see `hc_auth_approval` for revocation).

**Authentication**: Bearer token (same as POST endpoint).

**URL Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_key` | string | Base64-encoded agent key (URL-encoded) |

**Response** (`204 No Content`): No body.

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Invalid token |
| 404 | `not_found` | Agent key not found in runtime-registered list |

---

### 3.10 Admin Endpoints — Configuration and Behavior

The admin routes (`POST /v1/admin/allowed-agents`, `GET /v1/admin/allowed-agents`, `DELETE /v1/admin/allowed-agents/:agent_key`) are only enabled when `agent_registration.admin_secret` is configured in the server config. If this field is absent, the endpoints return 404.

**Registered vs. Static Agents**: When the `agent_allow_list` auth method is active, an agent is allowed if it appears in **either** the runtime-registered agents list **or** the static `allowed_agents` config array. Both sources are checked; they do not replace each other. This allows static configuration for bootstrap agents and runtime registration for pipeline-generated agents.

**Dependency on `auth_methods`**: Registering agents only affects joins when `agent_allow_list` is present in `auth_methods`. If `agent_registration.admin_secret` is configured without `agent_allow_list` in `auth_methods`, the admin routes are still mounted and registrations still succeed, but they have no effect on who can join — the server logs a startup warning in this case.

**Store Backend**: Registered agents are persisted using the same backend as the session store (`session.store` config):
- `memory` — agents are lost on server restart (ephemeral; suitable for development)
- `sqlite` — agents are persisted to disk in `allowed-agents.db` (same directory as `sessions.db`). Note: this file is created whenever `agent_allow_list` is configured in `auth_methods`, even without `agent_registration` — it backs the static `allowed_agents` list's lookups too.
- `cloudflare-kv` — works out of the box. The bundled worker entry constructs a `KvAllowedAgentStore` against the `SESSIONS` KV binding whenever `agent_allow_list` is in `auth_methods` or `agent_registration` is configured.

---

### 3.11 `POST /v1/admin/networks` — Register Network

Operator endpoint to register a network at runtime, enabling clients to join with network-specific roles and allowed agents. This is a complete, one-call registration: a network defined with its progenitor in `allowed_agents` can be immediately joined without additional configuration or restart.

Re-registering an existing `happ_id` replaces the record entirely. This does not revoke any challenges already issued to agents who were in a previous `allowed_agents` but are absent from the new one -- an agent that received an `agent_allow_list` challenge before the record changed can still complete that challenge and reach `ready`. Only the network's own `allowed_agents` gate at `POST /v1/join` sees the updated list; in-flight verification for an already-issued challenge is unaffected.

**Authentication**: Bearer token via `Authorization` header. The token value must match the server's `network_registration.admin_secret` config. Requests without the header return 401 `unauthorized`; requests with a wrong token return 403 `forbidden`.

**Request**:
```json
{
  "happ_id": "acme-network",
  "happ": {
    "name": "ACME network",
    "happ_bundle_url": "https://acme.example.com/acme.happ"
  },
  "roles": {
    "main": {
      "dna_hash": "uhC0k..."
    },
    "profile": {
      "dna_hash": "uhC0k...",
      "modifiers": {
        "network_seed": "acme-network-2026",
        "properties": { "region": "us-east" }
      }
    }
  },
  "allowed_agents": ["uhCAk..."]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `happ_id` | string | yes | Network identifier matching `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` -- the same identity space as a conductor installed-app id (dots included, for reverse-DNS-style ids). Must not equal the service's own statically configured happ id (`happ.id` in config); registering it is rejected with 400 `invalid_happ_id`, since that id already denotes the static network. |
| `happ` | object | no | Optional hApp metadata for this network, surfaced via `GET /v1/info/:happ_id` (Section 3.1). All sub-fields are optional. |
| `happ.name` | string | no | Human-readable name. Falls back to `happ_id` in `/v1/info/:happ_id` when absent. |
| `happ.description` | string | no | Short description |
| `happ.icon_url` | string (URL) | no | Icon URL |
| `happ.happ_bundle_url` | string (URL) | no | URL to download this network's .happ bundle. Independent of the service's own `happ.happ_bundle_url` -- there is no fallback between them. |
| `roles` | Record<string, RoleConfig> | yes | Per-role DNA configuration. Must not be empty. `dna_hash` is optional, but required per-role when the service has `membrane_proof.enabled` (it binds the membrane proof to a network); when present it is always validated. Each `dna_hash` must be unique across every other registered network and the service's own static `roles` -- a network's identity stands in for its DNA hash, so reusing a hash across two networks would let one agent join both and receive membrane proofs for the same cell twice; duplicates are rejected with 409 `duplicate_dna_hash`. Duplicates *within* one registration's own roles are allowed (same-DNA multi-role apps exist). Re-registering an existing `happ_id` is exempt from this check against its own prior hashes. `modifiers` is optional. |
| `allowed_agents` | string[] | no | Agent public keys allowed to join this network. Typically includes the network's progenitor. When non-empty, `POST /v1/join` rejects any other agent naming this network with 403 `join_rejected` -- this applies on top of whatever `auth_methods` the service otherwise requires, so it restricts joining even under `open` or `email_code` auth. An absent or empty list leaves the network unrestricted: any agent that satisfies the service's `auth_methods` may join it. |

**Response** (`201 Created`):
```json
{
  "happ_id": "acme-network",
  "happ": {
    "name": "ACME network",
    "happ_bundle_url": "https://acme.example.com/acme.happ"
  },
  "roles": {
    "main": { "dna_hash": "uhC0k..." },
    "profile": {
      "dna_hash": "uhC0k...",
      "modifiers": {
        "network_seed": "acme-network-2026",
        "properties": { "region": "us-east" }
      }
    }
  },
  "allowed_agents": ["uhCAk..."],
  "registered_at": "2026-02-24T12:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `happ_id` | string | The registered network's happ id |
| `happ` | object | hApp metadata mirrored from request (if provided) |
| `roles` | Record<string, RoleConfig> | Roles mirrored from request |
| `allowed_agents` | string[] | Allowed agent keys (if provided in request) |
| `registered_at` | string (ISO 8601) | Timestamp when the network was registered |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_happ_id` | `happ_id` does not match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, or it conflicts with the service's static happ id |
| 400 | `invalid_role_config` | `roles` is empty, a role's `dna_hash` is not a valid DnaHash, or `dna_hash` is missing on a role while `membrane_proof.enabled` is true (names the problematic role) |
| 400 | `invalid_agent_key` | An `allowed_agents` entry is not a valid base64-encoded 39-byte AgentPubKey |
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Authorization header present but token does not match `network_registration.admin_secret` |
| 409 | `duplicate_dna_hash` | A role's `dna_hash` is already used by another registered network or by the service's own static `roles` (names the hash and the owning network's `happ_id`) |

---

### 3.12 `GET /v1/admin/networks` — List Networks

Retrieve all registered networks (runtime-registered only; the statically configured network is not exposed here).

**Authentication**: Bearer token (same as POST endpoint).

**Response** (`200 OK`):
```json
{
  "networks": [
    {
      "happ_id": "acme-network",
      "happ": { "name": "ACME network" },
      "roles": { "main": { "dna_hash": "uhC0k..." }, "profile": { "dna_hash": "uhC0k..." } },
      "allowed_agents": ["uhCAk..."],
      "registered_at": "2026-02-24T12:00:00Z"
    },
    {
      "happ_id": "beta-network",
      "happ": { "name": "Beta network" },
      "roles": { "main": { "dna_hash": "uhC0k..." } },
      "registered_at": "2026-02-24T13:15:00Z"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `networks` | NetworkRecord[] | List of registered networks |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Invalid token |

---

### 3.13 `GET /v1/admin/networks/:happ_id` — Get Network

Retrieve a single registered network by id.

**Authentication**: Bearer token (same as POST endpoint).

**URL Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `happ_id` | string | Network identifier |

**Response** (`200 OK`):
```json
{
  "happ_id": "acme-network",
  "happ": { "name": "ACME network" },
  "roles": { "main": { "dna_hash": "uhC0k..." } },
  "allowed_agents": ["uhCAk..."],
  "registered_at": "2026-02-24T12:00:00Z"
}
```

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Invalid token |
| 404 | `not_found` | Network not registered |

---

### 3.14 `DELETE /v1/admin/networks/:happ_id` — Delete Network

Remove a network from the runtime-registered list. Existing sessions for that network are unaffected; provisioning a session whose network was deleted returns 404 `unknown_network`.

**Authentication**: Bearer token (same as POST endpoint).

**URL Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `happ_id` | string | Network identifier |

**Response** (`204 No Content`): No body.

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `unauthorized` | No Authorization header provided |
| 403 | `forbidden` | Invalid token |
| 404 | `not_found` | Network not registered |

---

### 3.15 Network Registration — Configuration and Behavior

The network registration routes (`POST /v1/admin/networks`, `GET /v1/admin/networks`, `GET/DELETE /v1/admin/networks/:happ_id`) are only enabled when `network_registration.admin_secret` is configured in the server config. If this field is absent, the endpoints return 404. A service with `network_registration` configured but no static `config.roles` is a valid, fully dynamic deployment: it has no roles of its own until networks are registered at runtime (see Section 3.1 for how `GET /v1/info` behaves without `roles`, and Section 3.2 for joining without a `network`).

**Store Backend**: Registered networks are persisted using the same backend as the session store (`session.store` config):
- `memory` — networks are lost on server restart (ephemeral; suitable for development)
- `sqlite` — networks are persisted to disk in `networks.db` (same directory as `sessions.db`)
- `cloudflare-kv` — works out of the box. The bundled worker entry constructs a `KvNetworkStore` against the `SESSIONS` KV binding whenever `network_registration` is configured. Note: KV's eventual consistency means two concurrent registrations of the same `happ_id` may race; the last write wins. The cross-network `dna_hash` uniqueness check (Section 3.11) is best-effort on this backend for the same reason: it lists all networks via a non-paginated KV `list()` under eventual consistency, so a duplicate registered moments earlier, or one from a list page not yet visible, can slip through undetected.

**One-Call Pipeline Registration**: A key use case is network provisioning pipelines: a network is registered with its progenitor agent in `allowed_agents`, and the progenitor immediately joins with `"network": "<happ_id>"`. The registration and join do not require config edits or service restart — they are independent API calls that, in sequence, form a complete onboarding path. Setting `allowed_agents` to the progenitor's key is what makes this safe to run against a service configured with `open` or `email_code` auth: without it, any agent naming the network would receive its membrane proofs, not just the progenitor the pipeline registered.

**`network_config` is service-wide**: `network_config` (bootstrap/relay/auth-server URLs, see Section 3.5) comes from the service's own config, not from a network registration -- it is identical for every session regardless of which `network` was joined. `roles` and `happ_bundle_url` (at both `/v1/info/:happ_id` and `GET /v1/join/{session}/provision`) come from the network's own registration instead, with no fallback to the service's static config.

---

## 4. Client Integration

Sections 2 and 3 define each endpoint on its own. This section covers the part a client has to work out for itself: given the state of the machine it is starting on, which endpoint to call.

### 4.1 Startup Decision Tree

Two pieces of purely local state decide which endpoint to call: whether an agent key exists, and whether the hApp is installed. Neither requires a server round trip to determine.

**hApp installed.** Normal startup; there is nothing to join. A client that wants current infrastructure URLs — because a `linker_urls` entry's `expires_at` has passed, or a connection attempt failed — calls `POST /v1/reconnect` (Section 3.6) for them.

**No agent key.** Generate one on the conductor's admin interface (`generateAgentPubKey`), record the association described in Section 4.2, then `POST /v1/join` (Section 3.2). There is nothing to recover.

**Agent key present, hApp not installed.** This covers both an install that was interrupted after joining and a genuine first run that has only got as far as generating a key. The client does not have to tell them apart: call `POST /v1/reconnect` with the `network` it intends to install, and branch on the response.

| Response | Meaning | Next call |
|----------|---------|-----------|
| `200` with `session` | The agent has a ready session on the requested network | `GET /v1/join/{session}/provision` (Section 3.5), then install |
| `200` without `session` | `network` was omitted or named the statically configured network, and that scope has no ready session | `POST /v1/join` |
| `403 agent_not_joined` | The agent has no ready session at all, or an explicitly named non-static network has none | `POST /v1/join` |

The provision call is the same one a fresh join would make, and it is repeatable: on the success path it writes no session state and mints a fresh membrane proof with a new nonce and timestamp per call. A client that crashes again partway through installing can call it again with the same token.

#### Why reconnect goes first

Not to avoid wasted work on the server. `POST /v1/join` returns `409 agent_already_joined` before it issues a challenge or sends any email, so trying join first and falling back to reconnect costs a round trip and nothing else. Both orders are safe: join's 409 returns before any challenge or email, and reconnect's only server-side effect is an idempotent re-registration with the linkers.

The reason is what each request needs from the caller. Reconnect needs an agent key and a signature over a timestamp, both of which the client produces on its own. Join may need claims — an email address, an invite code, a partner attestation — and, depending on the service's configured `auth_methods`, a prompt someone has to answer. Reconnect-first means an interrupted install completes silently, and an auth flow reaches the user only when the agent genuinely has to join something new.

Signing works in this state. The agent key is in lair from the moment `generateAgentPubKey` returns, independent of whether any app is installed, so a conductor holding a key and no app can still produce the reconnect signature.

### 4.2 Agent Key Persistence

A client must record the agent-key-to-hApp association in local storage **before** it calls `POST /v1/join`.

This is a requirement rather than advice because only one of the two orders is achievable. Local write, then remote call: whenever the process dies, the key is on disk, and the decision tree in Section 4.1 finds it and recovers. Remote call, then local write: the interval between the server committing the session and the client's write reaching disk belongs to neither party, and nothing the client can do closes it. Persisting the session token instead hits the same wall from a worse position — the token does not exist until the response arrives, so it can only be written after the state it is meant to recover already exists on the server.

What this ordering protects is not identity. A client that joins, crashes, and finds no recorded key on its next run generates a new one; the abandoned key has no chain and no cells, so nothing is forked and nothing is corrupt. What it loses is the join. `409 agent_already_joined` is scoped to the agent-key-plus-network pair (Section 3.2), so the ready session now belongs to a key the client can no longer name, and the new key has to clear authentication from the start. Where that means another invite code, the cost is real: the reference `invite_code` method consumes a code on first successful use, so an agent whose only credential was a single-use code, with no operator to issue a replacement, cannot join at all.

---

## 5. Error Response Format

All errors follow a consistent JSON structure:

```json
{
  "error": {
    "code": "invalid_agent_key",
    "message": "Agent key must be a valid base64-encoded 39-byte HoloHash",
    "details": {}
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error.code` | string | yes | Machine-readable error code (snake_case) |
| `error.message` | string | yes | Human-readable description |
| `error.details` | object | no | Additional type-specific context |

**Standard HTTP status codes**:
- `400` — Bad request (malformed input)
- `401` — Unauthorized (invalid/expired session)
- `403` — Forbidden (session not in correct state)
- `404` — Not found
- `409` — Conflict (duplicate agent)
- `410` — Gone (expired resource)
- `422` — Unprocessable entity (verification failed)
- `429` — Too many requests
- `500` — Internal server error

---

## 6. CORS and Rate Limiting

### CORS

The joining service must be callable from any origin (hApp UIs on arbitrary domains):

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

Session tokens are passed in the URL path (`/join/{session}/...`), not in headers. This avoids preflight request complications for simple GET/POST calls.

### Rate Limiting

Rate limit headers on every response:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1708776000
Retry-After: 30
```

Recommended limits:

| Endpoint | Limit | Scope |
|----------|-------|-------|
| `GET /v1/info` | 120/min | per IP |
| `POST /v1/join` | 10/min | per IP |
| `POST /v1/join/{session}/verify` | 5/min | per session |
| `GET /v1/join/{session}/provision` | 30/min | per session |
| `GET /v1/join/{session}/status` | 30/min | per session |
| `POST /v1/reconnect` | 10/min | per agent key |

---

## 7. Security Considerations

### Admission Control Scope

This service decides who is allowed to join a network. It does not prevent source-chain forks, and cannot.

Withholding a fresh membrane proof from an agent that has already joined does not stop that agent from running two conductors on one identity. Anyone holding the private key can copy the whole conductor directory — key, source chain, and the membrane proof issued at the original provision — and start a second node without contacting this service at all. Fork prevention is Holochain's: divergent chains are caught during validation and answered with warrants against the agent that produced them.

`409 agent_already_joined` is therefore not a fork guard and should not be defended as one. It exists because `POST /v1/join` carries no proof of key possession — it accepts an agent key, which is public information, and the session token it returns is a bearer credential for `GET /v1/join/{session}/provision`. Answering a repeat join with the existing session would let any third party who knows an agent's public key confirm that agent's membership, read `network_config`, the linker URLs, and the hApp bundle URL, and mint membrane proofs in that agent's name. It would also return before authentication is evaluated, so an agent removed from an allow list, or admitted on a since-revoked invite, would keep provisioning. The recovery path for the legitimate key holder is `POST /v1/reconnect` (Section 3.6), which requires a signature.

### Session Scoping
- Each session is bound to the `agent_key` that created it. Provision data is only issued for that agent.
- Session tokens: cryptographically random, at least 128 bits of entropy, prefixed `js_`.
- Expiry: pending sessions live for `session.pending_ttl_seconds` (default 86400, 24 hours); ready sessions do not expire.

### Agent Key Validation
- Server validates that `agent_key` decodes to exactly 39 bytes and starts with the AgentPubKey type prefix (`0x84, 0x20, 0x24`).
- The server does NOT verify private key ownership — that proof happens at the Holochain network level during genesis and all subsequent signed actions.

### Reconnect Replay Window

`POST /v1/reconnect` authenticates a caller by verifying an ed25519 signature over the request's `timestamp` and nothing else, accepting any timestamp within `reconnect.timestamp_tolerance_seconds` of server time (default 300). Ready sessions do not expire, so a reconnect request observed anywhere — a proxy log, a debug capture, a compromised client — can be replayed verbatim for the rest of that window and will be answered normally, including the network-scoped `session` token. That token is enough to call provision, which yields `network_config`, the hApp bundle URL, and a freshly minted membrane proof for the agent named in the replayed request.

Two things bound this. Requests are served over HTTPS (see Transport Security below), so the signature is not available to a passive network observer; and the tolerance is configurable, so a deployment whose clients have reliable clocks can narrow the window to a few seconds. Neither closes it, and neither bounds what follows: a token obtained this way stays usable indefinitely — ready sessions never expire, no endpoint revokes a session token, and the revocation check at provision only fires for sessions that used `hc_auth_approval`. The durable fix is to widen the signed payload beyond the bare timestamp — covering at least the agent key and a server-issued nonce — so that a captured signature cannot be replayed at all.

### Membrane Proof Integrity
- Generated server-side per DNA, typically includes agent key + DNA hash + timestamp + server signature.
- Returned per role in `roles[<role>].membrane_proof` (base64-encoded). Each role whose DNA requires a membrane proof gets its own entry.
- Opaque to the client (msgpack bytes, base64 for transport).
- Each DNA's `genesis_self_check` callback validates its own proof independently.

### Transport Security
- All endpoints must be served over HTTPS.
- The `.well-known` endpoint must be on the same origin as the hApp UI (prevents MITM redirection).

### Rate Limiting Rationale
- `POST /join` is aggressive (10/min) because each join may trigger email/SMS sends.
- Verification attempts limited per session to prevent brute-force of codes.

---

## 8. Authentication Methods Reference

| Method | Claims Required | Challenge Type | Response Format | Notes |
|--------|----------------|----------------|-----------------|-------|
| `open` | none | none | N/A | Instant `"ready"` status |
| `email_code` | `email` | 6-digit code via email | numeric string | Code masked in description |
| `sms_code` | `phone` | 6-digit code via SMS | numeric string | Phone masked in description |
| `evm_signature` | `evm_address` | Sign message | hex signature `0x...` | Signing payload in `metadata` |
| `solana_signature` | `solana_address` | Sign message | base58 signature | Signing payload in `metadata` |
| `invite_code` | `invite_code` | none | N/A | Validated at join time |
| `agent_allow_list` | none | Sign nonce | base64 ed25519 signature | Pre-approved agent keys only. Nonce in `metadata.nonce`. |
| `hc_auth_approval` | none | none (server-side) | N/A (poll `/status`) | Operator/KYC approval via hc-auth server. No client-side challenge — client polls status until approved or blocked. |
| `x-*` | custom | custom | custom | Developer-defined methods |

### Method Composition: AND / OR

Top-level entries in `auth_methods` are AND'd together -- the agent must satisfy every entry. An `{ any_of: [...] }` entry creates an OR group: the agent must satisfy at least one method in the group.

Example: invite code required, plus either email or SMS verification:
```json
{
  "auth_methods": ["invite_code", { "any_of": ["email_code", "sms_code"] }]
}
```

Challenges within the same OR group share a `group` field (e.g., `"g_0"`). The client can present these as alternatives and verify whichever the user completes.

### Agent Allow List Challenge

The `agent_allow_list` method verifies that an agent's public key is in a pre-defined allow list. The server generates a random nonce; the agent signs it with their ed25519 private key to prove identity.

- If the agent key is not in the allow list and the method is standalone (AND), the join is immediately rejected.
- If the agent key is not in the allow list but the method is in an OR group, the other methods in the group can still satisfy it.
- A named network's `allowed_agents` (Section 3.11) is a third source the plugin checks, alongside the static `allowed_agents` config and the `agent_registration` store: an agent listed there is eligible for this challenge when it joins naming that network, even if it appears in no other source.

Config:
```json
{
  "auth_methods": ["agent_allow_list"],
  "allowed_agents": ["uhCAk...base64-encoded-39-byte-AgentPubKey..."]
}
```

Challenge metadata sent to client:
```json
{
  "metadata": {
    "nonce": "base64-encoded-32-random-bytes"
  }
}
```

Verify request:
```json
{
  "challenge_id": "ch_agent_wl_1",
  "response": "base64-encoded-ed25519-signature-of-nonce-bytes"
}
```

### HC-Auth Approval

The `hc_auth_approval` method delegates join decisions to the hc-auth server. No client-side challenge is issued — instead, the agent is registered as pending in hc-auth, and the client polls `GET /status` until an operator (or external KYC provider) approves or blocks the agent.

- On `POST /v1/join`, the server registers the agent key with hc-auth in `pending` state.
- If the agent is already `authorized` in hc-auth, the join succeeds immediately (no challenge).
- If the agent is `blocked`, the join is immediately rejected.
- Otherwise, a `hc_auth_approval` challenge is created. The client polls `/status` — the server live-polls hc-auth on each status request.
- At provision and reconnect time, the server checks whether the agent is still authorized. If the agent has been blocked since joining, the request is rejected with `agent_revoked` (403).

Config:
```json
{
  "auth_methods": ["hc_auth_approval"],
  "hc_auth": {
    "server_url": "https://auth.example.com",
    "api_token": "secret-admin-token",
    "required": true
  }
}
```

`hc_auth` config fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `server_url` | string | yes | Base URL of the hc-auth-server (e.g. `https://auth.example.com`) |
| `api_token` | string | yes | Bearer token from the hc-auth-server's `API_TOKENS` config, used for admin API calls (transition, get) |
| `required` | boolean | no | If `true`, a failure to communicate with hc-auth blocks provisioning. Default: `false` (non-fatal — hc-auth outage does not break joining) |
| `forward_claims` | string[] | no | Claim keys to forward as metadata to hc-auth during registration (e.g. `["email", "phone"]`). When set, matching claims from the join session are included in the metadata payload sent to `PUT /request-auth/{pubkey}`. Only useful when other auth methods collect those claims (e.g. `email_code`, `sms_code`). Default: none |

Example with `forward_claims` — forwarding verified email to hc-auth alongside an email code challenge:
```json
{
  "auth_methods": ["email_code"],
  "hc_auth": {
    "server_url": "https://auth.example.com",
    "api_token": "secret-admin-token",
    "forward_claims": ["email"]
  }
}
```

Can be combined in OR groups:
```json
{
  "auth_methods": [{ "any_of": ["hc_auth_approval", "invite_code"] }]
}
```

### EVM Signature Challenge Metadata

```json
{
  "metadata": {
    "sign_method": "personal_sign",
    "message": "Join mewsfeed with agent uhCAk...\nNonce: x7y8z9\nTimestamp: 2026-02-24T12:00:00Z"
  }
}
```

The client uses ethers.js, viem, or wallet API to sign the message and returns the hex signature.

---

## 9. Example Flows

### 9.1 Open Join (no verification)

```
Client                                      Joining Service
  │                                              │
  ├─ GET /.well-known/holo-joining ────────────► │
  │◄─ { joining_service_url } ───────────────────┤
  │                                              │
  ├─ GET /v1/info ───────────────────────────────►│
  │◄─ { auth_methods: ["open"], ... } ───────────┤
  │                                              │
  ├─ POST /v1/join { agent_key } ────────────────►│
  │◄─ { session, status: "ready" } ──────────────┤
  │                                              │
  ├─ GET /v1/join/{session}/provision ──────────►│
  │◄─ { linker_urls, happ_bundle_url } ──────────┤
  │                                              │
  ├─ [fetch hApp bundle, install, connect] ──────►│
```

### 9.2 Email Verification

```
Client                                      Joining Service
  │                                              │
  ├─ GET /v1/info ───────────────────────────────►│
  │◄─ { auth_methods: ["email_code"] } ──────────┤
  │                                              │
  ├─ POST /v1/join                               │
  │  { agent_key, claims: { email } } ──────────►│
  │◄─ { session, status: "pending",              │
  │     challenges: [{ id, type: "email_code",   │
  │       description: "Enter code..." }] } ─────┤
  │                                              │
  │  (user checks email, gets code 482916)       │
  │                                              │
  ├─ POST /v1/join/{session}/verify              │
  │  { challenge_id, response: "482916" } ──────►│
  │◄─ { status: "ready" } ───────────────────────┤
  │                                              │
  ├─ GET /v1/join/{session}/provision ──────────►│
  │◄─ { linker_urls, roles } ────────────────────┤
```

### 9.3 EVM Wallet Signing

```
Client                                      Joining Service
  │                                              │
  ├─ POST /v1/join                               │
  │  { agent_key, claims: { evm_address } } ────►│
  │◄─ { session, status: "pending",              │
  │     challenges: [{ id, type: "evm_signature",│
  │       metadata: { sign_method, message } }] }┤
  │                                              │
  │  (user signs with MetaMask/wallet)           │
  │                                              │
  ├─ POST /v1/join/{session}/verify              │
  │  { challenge_id, response: "0x1a2b..." } ───►│
  │◄─ { status: "ready" } ───────────────────────┤
  │                                              │
  ├─ GET /v1/join/{session}/provision ──────────►│
  │◄─ { linker_urls, roles } ────────────────────┤
```

### 9.4 Read-Only Gateway Before Join

```
Client                                      Joining Service
  │                                              │
  ├─ GET /v1/info ───────────────────────────────►│
  │◄─ { http_gateways: [{ url, dna_hashes }] } ─┤
  │                                              │
  ├─ [route zome calls to http_gateways[0].url] ─►  hc-http-gw
  │◄─ [read-only results] ───────────────────────┤
  │                                              │
  │  (user decides to join)                      │
  │                                              │
  ├─ POST /v1/join { agent_key } ────────────────►│
  │  ... (normal join flow) ...                  │
  │                                              │
  ├─ [switch from http-gw to local WASM via linker]
```

### 9.5 Reconnect (Get Updated URLs)

```
Agent (already joined)                  Joining Service
  │                                          │
  │  (linker URLs expired or connectivity    │
  │   lost, needs fresh URLs)                │
  │                                          │
  ├─ POST /v1/reconnect                     │
  │  { agent_key: "uhCAk...",               │
  │    timestamp: "2026-02-25T12:00:00Z",   │
  │    signature: "base64..." } ────────────►│
  │                                          │
  │  (server verifies ed25519 signature      │
  │   and confirms agent has joined)         │
  │                                          │
  │◄─ { linker_urls: [{ url: "wss://...",   │
  │       expires_at: "..." }],             │
  │     http_gateways: [...] } ─────────────┤
  │                                          │
  ├─ [reconnect to new linker URLs] ────────►
```

### 9.6 OR Group (Email or SMS)

```
Client                                      Joining Service
  │                                              │
  ├─ GET /v1/info ───────────────────────────────►│
  │◄─ { auth_methods: [                          │
  │      { any_of: ["email_code","sms_code"] }   │
  │    ] } ────────────────────────────────────────┤
  │                                              │
  ├─ POST /v1/join                               │
  │  { agent_key,                                │
  │    claims: { email: "u@ex.com",              │
  │              phone: "+15551234" } } ─────────►│
  │◄─ { session, status: "pending",              │
  │     challenges: [                            │
  │       { id: "ch_email_1",                    │
  │         type: "email_code", group: "g_0" },  │
  │       { id: "ch_sms_1",                      │
  │         type: "sms_code", group: "g_0" }     │
  │     ] } ───────────────────────────────────────┤
  │                                              │
  │  (user picks email, enters code)             │
  │                                              │
  ├─ POST /v1/join/{session}/verify              │
  │  { challenge_id: "ch_email_1",              │
  │    response: "482916" } ─────────────────────►│
  │◄─ { status: "ready" } ────────────────────────┤
  │                                              │
  │  (SMS challenge was in same group,           │
  │   completing either one is sufficient)       │
```

### 9.7 Agent Allow List

```
Client                                      Joining Service
  │                                              │
  ├─ POST /v1/join { agent_key } ────────────────►│
  │                                              │
  │  (server checks agent_key is in allowed_agents)
  │                                              │
  │◄─ { session, status: "pending",              │
  │     challenges: [{                           │
  │       id: "ch_agent_al_1",                   │
  │       type: "agent_allow_list",               │
  │       metadata: { nonce: "base64..." }       │
  │     }] } ──────────────────────────────────────┤
  │                                              │
  │  (client signs nonce with agent ed25519 key) │
  │                                              │
  ├─ POST /v1/join/{session}/verify              │
  │  { challenge_id: "ch_agent_al_1",           │
  │    response: "base64-signature" } ────────────►│
  │◄─ { status: "ready" } ────────────────────────┤
```

### 9.8 HC-Auth Approval (Operator/KYC Gate)

```
Client                                      Joining Service          HC-Auth Server
  │                                              │                        │
  ├─ POST /v1/join { agent_key } ────────────────►│                        │
  │                                              ├─ PUT /request-auth ────►│
  │                                              │◄─ { state: "pending" } ─┤
  │◄─ { session, status: "pending",              │                        │
  │     challenges: [{                           │                        │
  │       id: "ch_hc_approval_1",                │                        │
  │       type: "hc_auth_approval",              │                        │
  │       description: "Awaiting approval" }]    │                        │
  │   } ─────────────────────────────────────────┤                        │
  │                                              │                        │
  │  (client polls status)                       │                        │
  ├─ GET /v1/join/{session}/status ──────────────►│                        │
  │                                              ├─ GET /api/record ──────►│
  │                                              │◄─ { state: "pending" } ─┤
  │◄─ { status: "pending" } ─────────────────────┤                        │
  │                                              │                        │
  │  (operator approves via hc-auth console)     │                        │
  │                                              │                        │
  ├─ GET /v1/join/{session}/status ──────────────►│                        │
  │                                              ├─ GET /api/record ──────►│
  │                                              │◄─ { state: "authorized" }
  │◄─ { status: "ready" } ───────────────────────┤                        │
  │                                              │                        │
  ├─ GET /v1/join/{session}/provision ──────────►│                        │
  │                                              ├─ GET /api/record ──────►│
  │                                              │◄─ { state: "authorized" }
  │◄─ { linker_urls, roles } ────────────────────┤                        │
```

### 9.9 Multi-Step Verification (Email + KYC)

```
Client                                      Joining Service
  │                                              │
  ├─ POST /v1/join { agent_key, claims: { email } }
  │◄─ { session, status: "pending",              │
  │     challenges: [                            │
  │       { id: "ch_email_1", type: "email_code" },
  │       { id: "ch_kyc_1", type: "x-kyc-review" }
  │     ] } ─────────────────────────────────────┤
  │                                              │
  ├─ POST /v1/join/{session}/verify              │
  │  { challenge_id: "ch_email_1", response: "482916" }
  │◄─ { status: "pending",                      │
  │     challenges_remaining: [                  │
  │       { id: "ch_kyc_1", type: "x-kyc-review",
  │         description: "Awaiting admin review" }
  │     ] } ─────────────────────────────────────┤
  │                                              │
  │  (poll while waiting for admin approval)     │
  ├─ GET /v1/join/{session}/status ──────────────►│
  │◄─ { status: "pending" } ─────────────────────┤
  │  ... (repeat polling) ...                    │
  ├─ GET /v1/join/{session}/status ──────────────►│
  │◄─ { status: "ready" } ───────────────────────┤
  │                                              │
  ├─ GET /v1/join/{session}/provision ──────────►│
  │◄─ { linker_urls, roles } ────────────────────┤
```

### 9.10 Recovery After an Interrupted Install

```
Client (agent key, no hApp)              Joining Service
  │                                          │
  │  (an earlier run joined, got a session   │
  │   token, and died before provisioning;   │
  │   POST /v1/join now answers 409)         │
  │                                          │
  ├─ POST /v1/reconnect                     │
  │  { agent_key: "uhCAk...",               │
  │    timestamp: "2026-02-25T12:00:00Z",   │
  │    signature: "base64...",              │
  │    network: "mewsfeed" } ───────────────►│
  │                                          │
  │  (server verifies the ed25519 signature  │
  │   and finds the agent's ready session    │
  │   on that network)                       │
  │                                          │
  │◄─ { linker_urls, http_gateways,         │
  │     session: "js_a1b2c3d4e5f6" } ───────┤
  │                                          │
  ├─ GET /v1/join/{session}/provision ─────►│
  │◄─ { linker_urls, roles,                 │
  │     happ_bundle_url } ──────────────────┤
  │                                          │
  ├─ [fetch hApp bundle, install, connect] ─►│
  │                                          │
  │  (had the agent never joined "mewsfeed", │
  │   reconnect would answer 403             │
  │   agent_not_joined and the client would  │
  │   fall through to POST /v1/join —        │
  │   see Section 4.1)                       │
```

---

## 10. TypeScript Type Definitions

These types define the API contract for client implementations:

```typescript
// --- Discovery ---

interface WellKnownHoloJoining {
  joining_service_url: string;
  happ_id: string;
  version: string;
}

// --- /v1/info ---

interface JoiningServiceInfo {
  happ: {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
  };
  http_gateways?: HttpGateway[];
  auth_methods: AuthMethodEntry[];
  /** Absent when the service does not manage linker relay URLs. */
  linker_info?: {
    selection_mode: 'assigned' | 'client_choice';
    region_hints?: string[];
  };
  happ_bundle_url?: string;
  /** Network service URLs. Only present when reveal_in_info is enabled in config. */
  network_config?: NetworkConfig;
  roles?: Record<string, { dna_modifiers?: DnaModifiers }>;
}

interface HttpGateway {
  url: string;
  dna_hashes: string[];
  status: 'available' | 'degraded' | 'offline';
  /** When this gateway entry expires. Absent means no known expiry. */
  expires_at?: string;
}

/** A linker WebSocket URL with an optional per-URL expiration. */
interface LinkerUrl {
  url: string;
  /** When this linker URL reservation expires. Absent means no known expiry. */
  expires_at?: string;
}

/** Base64-encoded 39-byte Holochain AgentPubKey. */
type AgentPubKeyB64 = string;

type AuthMethod =
  | 'open'
  | 'email_code'
  | 'sms_code'
  | 'evm_signature'
  | 'solana_signature'
  | 'invite_code'
  | 'agent_allow_list'
  | 'hc_auth_approval'
  | 'delegated_verification'
  | `x-${string}`;

interface AuthMethodGroup {
  any_of: AuthMethod[];
}

type AuthMethodEntry = AuthMethod | AuthMethodGroup;

interface DnaModifiers {
  network_seed?: string;
  properties?: Record<string, unknown>;
}

/** Per-role provision data, mirroring hc roles-settings. */
interface RoleProvision {
  /** Base64 membrane proof for this role's DNA. */
  membrane_proof?: string;
  dna_modifiers?: DnaModifiers;
}

/** Per-role DNA configuration, mirroring Holochain's app model. */
interface RoleConfig {
  /**
   * Base64 DnaHash ("uhC0k..."), strictly validated when present. Required
   * when `membrane_proof.enabled` — a membrane proof is bound to a network
   * via this hash. Must be the post-modifiers DNA hash as reported by the
   * conductor that installed the DNA (see DEPLOYMENT.md).
   */
  dna_hash?: string;
  /** Per-DNA modifiers for this role. */
  modifiers?: DnaModifiers;
}

/** A registered network's runtime configuration. */
interface NetworkRecord {
  happ_id: string;
  /** Optional hApp metadata for this network, surfaced via GET /v1/info/:happ_id. */
  happ?: {
    name?: string;
    description?: string;
    icon_url?: string;
    happ_bundle_url?: string;
  };
  /** Per-role DNA configuration for this network (same shape as config.roles). */
  roles: Record<string, RoleConfig>;
  /** Agents allowed to join this network via agent_allow_list, e.g. its progenitor. */
  allowed_agents?: AgentPubKeyB64[];
  registered_at: string;
}

// --- /v1/join ---

interface JoinRequest {
  agent_key: string;
  claims?: Record<string, string>;
  /** Named network to join. Must be registered with the service (see network_registration). */
  network?: string;
}

interface JoinResponse {
  session: string;
  status: 'ready' | 'pending';
  challenges?: Challenge[];
  poll_interval_ms?: number;
}

interface Challenge {
  id: string;
  type: AuthMethod;
  description: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
  completed?: boolean;
  /** Challenges sharing the same group are OR alternatives. */
  group?: string;
}

// --- /v1/join/{session}/verify ---

interface VerifyRequest {
  challenge_id: string;
  response: string;
}

interface VerifyResponse {
  status: 'ready' | 'pending' | 'rejected';
  challenges_remaining?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

// --- /v1/join/{session}/status ---

interface StatusResponse {
  status: 'ready' | 'pending' | 'rejected';
  challenges?: Challenge[];
  reason?: string;
  poll_interval_ms?: number;
}

// --- Network config (shared by /v1/info and /v1/join/{session}/provision) ---

interface NetworkConfig {
  auth_server_url?: string;
  bootstrap_url?: string;
  relay_url?: string;
}

// --- /v1/join/{session}/provision ---

interface JoinProvision {
  /** Absent when the service does not manage linker relay URLs. Each entry may carry its own expiry. */
  linker_urls?: LinkerUrl[];
  happ_bundle_url?: string;
  /** Network service URLs for conductor configuration. Only present when at least one URL is available. */
  network_config?: NetworkConfig;
  roles?: Record<string, RoleProvision>;
}

// --- /v1/reconnect ---

interface ReconnectRequest {
  agent_key: string;
  timestamp: string;
  signature: string;
  /** Named network to reconnect to. Omitted, or equal to the static happ_id, selects the static network's session. */
  network?: string;
}

interface ReconnectResponse {
  /** Absent when the service does not manage linker relay URLs. Each entry may carry its own expiry. */
  linker_urls?: LinkerUrl[];
  http_gateways?: HttpGateway[];
  /** Session token for the requested network's ready session. Absent when the (possibly static-defaulted) scope has no ready session. */
  session?: string;
}

// --- Errors ---

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```
