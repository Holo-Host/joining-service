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

---

## 3. Endpoints

### 3.1 `GET /v1/info` — Service Info

Returns hApp metadata, available read-only gateways, supported auth methods, and linker information. **Unauthenticated** — anyone loading the page can call this.

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
  "dna_modifiers": {
    "network_seed": "mewsfeed-mainnet-2026",
    "properties": {}
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
| `auth_methods` | AuthMethodEntry[] | yes | Supported authentication methods (see Section 7). Each entry is either an `AuthMethod` string or an `{ any_of: AuthMethod[] }` group. Top-level entries are AND'd; methods within an `any_of` group are OR'd. |
| `linker_info` | object | no | Absent when the service does not manage linker relay URLs (e.g. pure membrane-proof or gateway-only deployments) |
| `linker_info.selection_mode` | string | if linker_info present | `"assigned"` (server picks linker) or `"client_choice"` (client picks from list) |
| `linker_info.region_hints` | string[] | no | Available regions for latency optimization |
| `happ_bundle_url` | string (URL) | no | URL to download the .happ bundle. May be absent if gated behind auth. |
| `dna_modifiers` | object | no | DNA modifiers to apply during installation |
| `dna_modifiers.network_seed` | string | no | Network seed for DNA hash computation |
| `dna_modifiers.properties` | object | no | DNA properties (arbitrary JSON, msgpack-encoded by client) |
| `network_config` | object | no | Network service URLs. Only present when `network.reveal_in_info` is enabled in config (default: off). Exposing these URLs publicly may increase DDoS surface area for the listed services. |
| `network_config.auth_server_url` | string (URL) | no | HC-Auth server URL (derived from `hc_auth.url` config) |
| `network_config.bootstrap_url` | string (URL) | no | Bootstrap server URL |
| `network_config.relay_url` | string (URL) | no | Relay server URL |

---

### 3.2 `POST /v1/join` — Initiate Join

The client sends its agent key and optional identity claims. The server determines what verification (if any) is required.

**Request**:
```json
{
  "agent_key": "uhCAk...",
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

**Response** (`201 Created`) — rejected:
```json
{
  "session": "js_r1r2r3",
  "status": "rejected",
  "reason": "This hApp requires an invite code"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session` | string | yes | Opaque session token (prefixed `js_`) |
| `status` | string | yes | `"ready"`, `"pending"`, or `"rejected"` |
| `challenges` | array | if pending | Verification challenges to complete |
| `challenges[].id` | string | yes | Challenge identifier (used in verify endpoint) |
| `challenges[].type` | string | yes | Challenge type (matches `auth_methods` values) |
| `challenges[].description` | string | yes | Human-readable instruction for the user |
| `challenges[].expires_at` | string (ISO 8601) | no | When this challenge expires |
| `challenges[].metadata` | object | no | Type-specific data (e.g., EVM signing payload, nonce for agent_allow_list) |
| `challenges[].group` | string | no | OR group identifier. Challenges sharing the same group are alternatives -- completing any one satisfies the group. |
| `reason` | string | if rejected | Human-readable rejection reason |
| `poll_interval_ms` | number | if pending | Suggested polling interval in milliseconds |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_agent_key` | Agent key is not valid base64 or not 39 bytes |
| 400 | `missing_claims` | Required claims for this hApp's auth method were not provided |
| 409 | `agent_already_joined` | This agent key has already completed joining. Use `POST /v1/reconnect` instead. |
| 429 | `rate_limited` | Too many join attempts |

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

Same response shape as the join response.

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 401 | `invalid_session` | Session token is invalid or expired |
| 410 | `session_expired` | Session has expired entirely |

---

### 3.5 `GET /v1/join/{session}/provision` — Get Provision

Retrieve the provision data needed to connect to the Holochain network. Only available when session status is `"ready"`.

**Response** (`200 OK`):
```json
{
  "linker_urls": [
    { "url": "wss://linker1.example.com:8090" },
    { "url": "wss://linker2.example.com:8090", "expires_at": "2026-02-25T18:00:00Z" }
  ],
  "membrane_proofs": {
    "uhC0k_chat_dna_hash...": "gqNPa6RkYXRh...",
    "uhC0k_profile_dna_hash...": "hRtYm9keW..."
  },
  "happ_bundle_url": "https://app.example.com/mewsfeed.happ",
  "dna_modifiers": {
    "network_seed": "mewsfeed-mainnet-2026",
    "properties": {}
  },
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
| `membrane_proofs` | object | no | Map of DnaHash (base64-encoded, e.g. `uhC0k...`) to base64-encoded msgpack membrane proof bytes. One entry per DNA role that requires a membrane proof. Absent/empty if the hApp has no membrane requirement. |
| `happ_bundle_url` | string (URL) | no | URL to fetch the .happ bundle. May differ from `/info` response (gated behind auth). |
| `dna_modifiers` | object | no | DNA modifiers to apply during installation |
| `dna_modifiers.network_seed` | string | no | Network seed |
| `dna_modifiers.properties` | object | no | DNA properties (JSON; client encodes to msgpack) |
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
| 410 | `session_expired` | Session has expired; must start over |

---

### 3.6 `POST /v1/reconnect` — Reconnect (Get Updated URLs)

An agent that has already completed joining can request updated linker URLs and gateway URLs. This is used when:
- One or more linker URL reservations have expired (per-entry `expires_at` has passed)
- The client has lost connectivity and needs fresh infrastructure URLs
- The pool of available linkers or gateways has changed

This endpoint does **not** re-run verification challenges. Instead, the agent proves key ownership by signing a timestamp with their ed25519 private key.

**Request**:
```json
{
  "agent_key": "uhCAk...",
  "timestamp": "2026-02-25T12:00:00Z",
  "signature": "base64-encoded-ed25519-signature-of-timestamp"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_key` | string | yes | Base64-encoded 39-byte AgentPubKey (same key used during join) |
| `timestamp` | string (ISO 8601) | yes | Current UTC timestamp. Server rejects if more than 5 minutes from server time. |
| `signature` | string | yes | Base64-encoded ed25519 signature of the exact `timestamp` string, signed with the private key corresponding to `agent_key` |

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
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `linker_urls` | LinkerUrl[] | no | Updated ordered list of linker URL entries. Absent when the service does not manage linker relay URLs. Each entry may carry its own `expires_at`. |
| `http_gateways` | array | no | Current read-only gateway instances (same schema as `/v1/info`). Each entry may carry its own `expires_at`. |

**Errors**:

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `invalid_agent_key` | Agent key is not valid base64 or not 39 bytes |
| 400 | `invalid_signature` | Signature does not verify against agent key |
| 400 | `timestamp_out_of_range` | Timestamp is more than 5 minutes from server time |
| 403 | `agent_not_joined` | This agent key has not completed joining |
| 403 | `agent_revoked` | Agent was blocked by administrator (hc_auth_approval revocation) |
| 429 | `rate_limited` | Too many reconnect attempts |

---

### 3.7 `POST /v1/admin/allowed-agents` — Register Allowed Agent

Operator endpoint to register an agent key at runtime, enabling it to join via the `agent_allow_list` auth method. This complements the static `allowed_agents` config list — registered agents and config-listed agents are treated identically during join authorization.

Re-registering an existing `agent_key` replaces the record, including clearing a previously set `label` if none is supplied.

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

**Response** (`201 Created`):
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
| `registered_at` | string (ISO 8601) | Timestamp when the agent was registered |

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
- `cloudflare-kv` — requires manual wiring in the worker entry. The worker must construct a `KvAllowedAgentStore` and pass it as `allowedAgentStore` in the ServiceContext. The bundled worker entry does not wire this yet; admin routes are only available on Node deployments out of the box.

---

## 4. Error Response Format

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

## 5. CORS and Rate Limiting

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

## 6. Security Considerations

### Session Scoping
- Each session is bound to the `agent_key` that created it. Provision data is only issued for that agent.
- Session tokens: cryptographically random, at least 128 bits of entropy, prefixed `js_`.
- Expiry: 1 hour for pending sessions, 24 hours for ready sessions.

### Agent Key Validation
- Server validates that `agent_key` decodes to exactly 39 bytes and starts with the AgentPubKey type prefix (`0x84, 0x20, 0x24`).
- The server does NOT verify private key ownership — that proof happens at the Holochain network level during genesis and all subsequent signed actions.

### Membrane Proof Integrity
- Generated server-side per DNA, typically includes agent key + DNA hash + timestamp + server signature.
- `membrane_proofs` is a map of DnaHash → base64-encoded proof. Each DNA that requires a membrane proof gets its own entry.
- Opaque to the client (msgpack bytes, base64 for transport).
- Each DNA's `genesis_self_check` callback validates its own proof independently.

### Transport Security
- All endpoints must be served over HTTPS.
- The `.well-known` endpoint must be on the same origin as the hApp UI (prevents MITM redirection).

### Rate Limiting Rationale
- `POST /join` is aggressive (10/min) because each join may trigger email/SMS sends.
- Verification attempts limited per session to prevent brute-force of codes.

---

## 7. Authentication Methods Reference

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

## 8. Example Flows

### 8.1 Open Join (no verification)

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

### 8.2 Email Verification

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
  │◄─ { linker_urls, membrane_proofs } ──────────┤
```

### 8.3 EVM Wallet Signing

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
  │◄─ { linker_urls, membrane_proofs } ──────────┤
```

### 8.4 Read-Only Gateway Before Join

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

### 8.5 Reconnect (Get Updated URLs)

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
  │◄─ { linker_urls: ["wss://..."],         │
  │     http_gateways: [...],               │
  │     linker_urls_expire_at: "..." } ─────┤
  │                                          │
  ├─ [reconnect to new linker URLs] ────────►
```

### 8.6 OR Group (Email or SMS)

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

### 8.7 Agent Allow List

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

### 8.8 HC-Auth Approval (Operator/KYC Gate)

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
  │◄─ { linker_urls, membrane_proofs } ──────────┤                        │
```

### 8.9 Multi-Step Verification (Email + KYC)

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
  │◄─ { linker_urls, membrane_proofs } ──────────┤
```

---

## 9. TypeScript Type Definitions

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
  linker_info?: {
    selection_mode: 'assigned' | 'client_choice';
    region_hints?: string[];
  };
  happ_bundle_url?: string;
  dna_modifiers?: DnaModifiers;
  /** Only present when reveal_in_info is enabled in config. */
  network_config?: NetworkConfig;
}

interface HttpGateway {
  url: string;
  dna_hashes: string[];
  status: 'available' | 'degraded' | 'offline';
  /** When this gateway entry expires. Absent means no known expiry. */
  expires_at?: string;
}

/** A linker WebSocket URL with optional per-URL expiration. */
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
  | `x-${string}`;

interface AuthMethodGroup {
  any_of: AuthMethod[];
}

type AuthMethodEntry = AuthMethod | AuthMethodGroup;

interface DnaModifiers {
  network_seed?: string;
  properties?: Record<string, unknown>;
}

// --- /v1/join ---

interface JoinRequest {
  agent_key: string;
  claims?: Record<string, string>;
}

interface JoinResponse {
  session: string;
  status: 'ready' | 'pending' | 'rejected';
  challenges?: Challenge[];
  reason?: string;
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

// --- Network config (shared by /v1/info and /v1/join/{session}/provision) ---

interface NetworkConfig {
  auth_server_url?: string;
  bootstrap_url?: string;
  relay_url?: string;
}

// --- /v1/join/{session}/provision ---

interface JoinProvision {
  /** Each entry may carry its own expires_at. Absent when service does not manage linker relay URLs. */
  linker_urls?: LinkerUrl[];
  membrane_proofs?: Record<string, string>;
  happ_bundle_url?: string;
  dna_modifiers?: DnaModifiers;
  /** Network service URLs for conductor configuration. */
  network_config?: NetworkConfig;
}

// --- /v1/reconnect ---

interface ReconnectRequest {
  agent_key: string;
  timestamp: string;
  signature: string;
}

interface ReconnectResponse {
  /** Each entry may carry its own expires_at. Absent when service does not manage linker relay URLs. */
  linker_urls?: LinkerUrl[];
  /** Each entry may carry its own expires_at. */
  http_gateways?: HttpGateway[];
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
