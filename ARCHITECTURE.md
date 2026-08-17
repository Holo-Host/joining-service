# Joining Service Architecture

This document describes the high-level architecture of the Joining Service, the different node types it supports, and the spectrum of configuration profiles from fully open to fully locked down.

---

## System Context

The Joining Service is a per-hApp REST API that brokers onboarding for Holochain applications running in the Holo ecosystem. It sits between agents (browser extensions, native apps) and the network infrastructure (linkers, bootstrap servers, gateways), controlling who can join and what credentials they receive.

```mermaid
graph TB
    subgraph Agents
        HWC[Browser Extension<br/>Holo Web Conductor]
        Native[Native Node<br/>Desktop / CLI]
        Browse[Browse-Only Client]
    end

    subgraph "Joining Service (per hApp)"
        JS[Joining Service API]
        Auth[Auth Method Plugins]
        Sessions[Session Store]
        MembProof[Membrane Proof Generator]
    end

    subgraph "Network Infrastructure"
        Linker[Linker Relay Servers<br/>WebSocket relays]
        Bootstrap[HC-Auth / Bootstrap Server<br/>kitsune2-bootstrap-srv]
        Gateway[HTTP Gateways<br/>Read-only DHT access]
    end

    subgraph "Infrastructure Management<br/>(Planned)"
        KV[Cloudflare KV Stores<br/>Dynamic URL pools]
    end

    HWC -->|discover + join| JS
    Native -->|join| JS
    Browse -->|info + gateways| JS

    JS --> Auth
    JS --> Sessions
    JS --> MembProof

    JS -->|authorize agent| Linker
    JS -->|register + authorize| Bootstrap
    JS -->|read URLs| Gateway

    KV -.->|linker_registrations| JS
    KV -.->|http_gateways| JS
    KV -.->|managed pools| Linker
    KV -.->|managed pools| Gateway
```

---

## Configuration Spectrum

The joining service supports a range of deployment profiles. Each capability is independently optional—operators compose only what their hApp needs.

```mermaid
graph LR
    subgraph "← Open"
        A["Fully Open<br/>No auth, no proofs"]
    end
    subgraph "Moderate"
        B["Invite-Gated<br/>Invite codes"]
        C["Email-Verified<br/>Email code challenge"]
    end
    subgraph "Locked Down →"
        D["Multi-Factor<br/>Email + invite"]
        D2["HC-Auth Approval<br/>Operator/KYC gate"]
        E["Full Stack<br/>Auth + proofs + linker auth<br/>+ HC-Auth"]
    end

    A --> B --> C --> D --> D2 --> E

    style A fill:#2d6a2d,color:#fff
    style B fill:#4a7a2d,color:#fff
    style C fill:#7a7a2d,color:#fff
    style D fill:#7a4a2d,color:#fff
    style D2 fill:#7a3a2d,color:#fff
    style E fill:#7a2d2d,color:#fff
```

### Profile 1: Fully Open

No authentication, no membrane proofs. Any agent can join immediately.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['open']` |
| `membrane_proof` | not configured |
| `hc_auth` | not configured |
| `linker_auth` | not configured |

**Use cases**: Public test networks, open hApps, local development.

**Flow**: `POST /v1/join` → immediate `status: "ready"` → `GET /provision` returns linker URLs and bundle URL.

---

### Profile 2: Invite-Gated

Single-use invite codes control who can join. No ongoing identity verification.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['invite_code']` |
| `invite_codes` | `['CODE1', 'CODE2', ...]` |
| `membrane_proof` | optional |

**Use cases**: Beta programs, limited rollouts, paid access (codes issued after payment externally).

**Flow**: `POST /v1/join` with `claims: { invite_code: "CODE1" }` → auto-verified at join time → `status: "ready"` or `status: "rejected"`.

---

### Profile 3: Email-Verified

Agent must prove control of an email address via 6-digit code.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['email_code']` |
| `email` | provider + api_key + from + template |
| `membrane_proof` | optional |

**Use cases**: Consumer apps requiring identity, apps needing contact info for notifications.

**Flow**: `POST /v1/join` with `claims: { email: "user@example.com" }` → `status: "pending"` with challenge → user receives email → `POST /verify` with code → `status: "ready"`.

---

### Profile 4: Multi-Factor

Multiple auth methods combined. Top-level entries are AND'd; `{ any_of: [...] }` entries create OR groups where any one method suffices.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['invite_code', { any_of: ['email_code', 'sms_code'] }]` |
| `email` | configured |
| `invite_codes` | configured |
| `membrane_proof` | optional |

**Use cases**: Higher-trust networks, regulated applications, user-choice verification channels.

**Flow**: Invite code verified at join time. Email and SMS challenges issued as OR alternatives (same `group` id). Agent verifies whichever channel they prefer to reach `status: "ready"`.

### Profile 4b: Agent Allow List

Pre-approved agent keys sign a nonce to prove identity. Can be standalone or combined with other methods in OR groups.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['agent_allow_list']` or `[{ any_of: ['agent_allow_list', 'invite_code'] }]` |
| `allowed_agents` | `['uhCAk...', 'uhCAk...']` |
| `membrane_proof` | optional |

**Use cases**: Known-participant networks, testing with specific agent keys, fallback to invite codes for new agents.

**Flow**: `POST /v1/join` checks if `agent_key` is in the allow list. If yes, returns a nonce challenge. Agent signs the nonce with their ed25519 key and submits via `POST /verify`. If in an OR group with other methods, non-allow-listed agents can use the alternatives.

### Profile 4c: HC-Auth Approval

Delegates join decisions to the hc-auth server. The agent is registered as pending and an operator (or external KYC provider) approves or blocks them via the hc-auth ops console. The client polls `/status` until the decision is made. Revocation checks are enforced at provision and reconnect time.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['hc_auth_approval']` or combined in OR groups |
| `hc_auth` | configured (server URL + credentials) |
| `membrane_proof` | optional |

**Use cases**: Operator-gated networks, KYC-required apps, manual review workflows.

**Flow**: `POST /v1/join` registers agent as pending in hc-auth → `status: "pending"` with `hc_auth_approval` challenge → client polls `GET /status` → operator approves via hc-auth console → next poll returns `status: "ready"`. If blocked, returns `status: "rejected"`.

---

### Profile 5: Full Stack (Maximum Security)

All authorization layers active. Agent must pass auth challenges, receives signed membrane proofs, gets authorized on linker admin API, and gets registered with HC-Auth bootstrap server.

| Setting | Value |
|---------|-------|
| `auth_methods` | `['email_code']` (or any combination, including OR groups and `agent_allow_list`) |
| `membrane_proof.enabled` | `true` |
| `membrane_proof.signing_key_path` | path to persistent key |
| `hc_auth.required` | `true` |
| `linker_auth.required` | `true` |
| `linker_auth.capabilities` | `['dht_read', 'dht_write', 'k2']` |

**Use cases**: Production Holo-hosted apps with full infrastructure control.

**Flow**:
```mermaid
sequenceDiagram
    participant Agent as Browser Extension
    participant JS as Joining Service
    participant Email as Email Provider
    participant Lair as Lair Keystore
    participant Linker as Linker Admin API
    participant HCAuth as HC-Auth Server

    Agent->>JS: GET /v1/info
    JS-->>Agent: happ metadata, auth_methods, linker_info

    Agent->>JS: POST /v1/join {agent_key, claims: {email}}
    JS-->>Agent: status: "pending", challenges: [{type: "email_code"}]
    JS->>Email: Send 6-digit code

    Agent->>JS: POST /v1/join/:session/verify {code}

    Note over JS: All challenges passed

    JS->>Lair: Sign membrane proofs for each DNA
    Lair-->>JS: Signed proofs

    JS->>HCAuth: PUT /request-auth/{pubkey}
    JS->>HCAuth: POST /api/transition → authorized
    HCAuth-->>JS: 200 OK

    JS->>Linker: POST /admin/agents {agent_pubkey, capabilities}
    Linker-->>JS: 200 OK

    JS-->>Agent: status: "ready"

    Agent->>JS: GET /v1/join/:session/provision
    JS-->>Agent: linker_urls, roles, happ_bundle_url

    Note over Agent: Install hApp with proofs,<br/>connect to linker
```

---

## Node Types

```mermaid
graph TB
    subgraph "Agent Types"
        direction TB

        Browser["<b>Browser Node</b><br/>(Holo Web Conductor Extension)<br/>━━━━━━━━━━━━━<br/>Needs: linker URLs<br/>Needs: membrane proofs (if DNA requires)<br/>Optional: HTTP gateways (pre-join browsing)<br/>Transport: WebSocket via linker relay"]

        NativeNode["<b>Native Node</b><br/>(Desktop App / CLI)<br/>━━━━━━━━━━━━━<br/>Needs: membrane proofs (if DNA requires)<br/>No linker needed (direct networking)<br/>Optional: HTTP gateways<br/>Transport: direct libp2p / kitsune2"]

        GatewayOnly["<b>Gateway-Only Client</b><br/>(Browse Before Join)<br/>━━━━━━━━━━━━━<br/>Needs: HTTP gateway URLs<br/>No linker, no proofs<br/>Read-only DHT access<br/>Transport: HTTP GET"]
    end

    style Browser fill:#1a5276,color:#fff
    style NativeNode fill:#1a5276,color:#fff
    style GatewayOnly fill:#1a5276,color:#fff
```

### Browser Node (HWC Extension)
The primary use case. The browser extension cannot run a full Holochain node directly, so it connects through a **linker relay server** via WebSocket. The joining service provides:
- Linker URLs (assigned or client-choice)
- Membrane proofs (signed by the service's progenitor key)
- hApp bundle URL for installation
- DNA modifiers (network seed, properties)

### Native Node
Desktop or CLI-based Holochain nodes that handle their own networking. They only need the joining service for membrane proofs (if the DNA's `genesis_self_check` enforces membership). Linker URLs are unnecessary since native nodes connect directly via kitsune2.

### Gateway-Only Client
A read-only access mode for clients that want to browse DHT data before committing to join. Uses HTTP gateway endpoints to read zome calls without installing the hApp. No authentication required for gateway access (the gateways themselves are public read endpoints).

---

## Infrastructure Services

```mermaid
graph TB
    subgraph "Infrastructure Layer"
        direction LR

        subgraph "Linker Relay Pool"
            L1[Linker 1<br/>wss://linker-us.example.com]
            L2[Linker 2<br/>wss://linker-eu.example.com]
            L3[Linker N<br/>...]
        end

        subgraph "HTTP Gateway Pool"
            G1[Gateway 1<br/>https://gw-us.example.com]
            G2[Gateway 2<br/>https://gw-eu.example.com]
        end

        subgraph "Bootstrap / Auth"
            HC[HC-Auth Server<br/>Agent registration &<br/>authorization for<br/>bootstrap services]
        end
    end

    subgraph "URL Management"
        Static["<b>StaticUrlProvider</b><br/>Hardcoded at startup<br/>from config file"]
        KVProv["<b>KvUrlProvider</b><br/>Dynamic from<br/>Cloudflare KV"]
        Future["<b>Pool Manager</b><br/>(Planned)<br/>Health checks,<br/>auto-scaling,<br/>region routing"]
    end

    Static --> L1
    Static --> G1
    KVProv --> L1
    KVProv --> L2
    KVProv --> G1
    KVProv --> G2
    Future -.-> L1
    Future -.-> L2
    Future -.-> L3
    Future -.-> G1
    Future -.-> G2

    style Future fill:#555,color:#ccc,stroke-dasharray: 5 5
```

### Linker Relay Servers
WebSocket relay servers (`h2hc-linker`) that route Holochain messages for browser-based nodes. Each linker can optionally have an **admin API** that the joining service calls to pre-authorize agents with specific capabilities (`dht_read`, `dht_write`, `k2`).

- **Open linkers**: No admin API, any agent can connect.
- **Authorized linkers**: Admin API with bearer token. Joining service calls `POST /admin/agents` to add agent keys to the allow list.

### HTTP Gateways
Read-only HTTP endpoints that proxy zome calls against the DHT. Used for browse-before-join UX. Each gateway entry includes:
- URL
- Which DNA hashes it serves
- Health status (`available` / `degraded` / `offline`)
- Optional expiration

### HC-Auth Server
Central authorization gate for bootstrap/discovery services (kitsune2-bootstrap-srv). The joining service registers agents and transitions them to `authorized` state, allowing them to use bootstrap infrastructure.

---

## Planned: Infrastructure Pool Management via Cloudflare KV

The `KvUrlProvider` and `KvSessionStore` lay groundwork for a dynamic infrastructure management layer. This is partially implemented (KV reads work) but the management/orchestration side is not yet built.

```mermaid
graph TB
    subgraph "Planned: Pool Management Service"
        PM["Pool Manager<br/>(Not Yet Implemented)"]
        PM -->|health checks| L1[Linker 1]
        PM -->|health checks| L2[Linker 2]
        PM -->|health checks| G1[Gateway 1]
        PM -->|health checks| G2[Gateway 2]
        PM -->|update pools| KV[(Cloudflare KV)]
    end

    subgraph "Joining Service (Cloudflare Worker)"
        JS[Joining Service]
        JS -->|read| KV
    end

    subgraph "Planned Capabilities"
        direction TB
        Cap1["Auto-registration<br/>Linkers/gateways self-register<br/>with the pool manager"]
        Cap2["Health monitoring<br/>Periodic checks, automatic<br/>removal of unhealthy nodes"]
        Cap3["Region-aware routing<br/>Match agents to nearest<br/>infrastructure by region_hints"]
        Cap4["Capacity management<br/>Track connection counts,<br/>route to least-loaded nodes"]
        Cap5["Credential rotation<br/>Rotate admin tokens and<br/>signing keys across fleet"]
    end

    style PM fill:#555,color:#ccc,stroke-dasharray: 5 5
    style Cap1 fill:#444,color:#aaa,stroke-dasharray: 5 5
    style Cap2 fill:#444,color:#aaa,stroke-dasharray: 5 5
    style Cap3 fill:#444,color:#aaa,stroke-dasharray: 5 5
    style Cap4 fill:#444,color:#aaa,stroke-dasharray: 5 5
    style Cap5 fill:#444,color:#aaa,stroke-dasharray: 5 5
```

### What exists today
- **KvUrlProvider**: Reads `linker_registrations` and `http_gateways` keys from Cloudflare KV at request time. No redeployment needed to change URLs.
- **KvSessionStore**: Persists sessions to Cloudflare KV with native TTL-based expiration.
- **LinkerRegistration**: Each linker entry can include admin URL + bearer token for authorized access.
- **HttpGateway**: Each gateway entry includes health status and optional expiration.

### What is not yet built
- **Pool Manager service**: No orchestration layer manages the KV entries. Today they are written manually or by external tooling.
- **Health checks**: No automated monitoring of linker/gateway health.
- **Auto-registration**: Linkers and gateways don't self-register; URLs must be manually added to KV.
- **Region routing**: `region_hints` field exists in config but no matching logic routes agents to nearby infrastructure.
- **Capacity tracking**: No connection counting or load-aware routing.
- **Credential rotation**: Signing keys and admin tokens are static after deployment.

---

## Deployment Targets

```mermaid
graph LR
    subgraph "Deployment Options"
        direction TB

        Local["<b>Local / Dev</b><br/>Node.js process<br/>MemorySessionStore<br/>FileTransport (email)<br/>StaticUrlProvider"]

        Docker["<b>Docker / VPS</b><br/>Node.js in container<br/>SqliteSessionStore<br/>Postmark/SendGrid<br/>StaticUrlProvider"]

        CF["<b>Cloudflare Worker</b><br/>Edge runtime<br/>KvSessionStore<br/>Postmark/SendGrid<br/>KvUrlProvider"]
    end

    style Local fill:#2d6a4e,color:#fff
    style Docker fill:#1a5276,color:#fff
    style CF fill:#6a2d6a,color:#fff
```

| Component | Local/Dev | Docker/VPS | Cloudflare Worker |
|-----------|-----------|------------|-------------------|
| Runtime | Node.js | Node.js | Workers runtime |
| Session store | Memory | SQLite (file) | Cloudflare KV |
| Email transport | File (writes .txt) | Postmark or SendGrid | Postmark or SendGrid |
| URL provider | Static | Static | KV (dynamic) |
| Config source | JSON file | JSON file | Environment vars + secrets |
| Scaling | Single instance | Single instance | Edge (multi-region) |

---

## Auth Method Plugin Architecture

Auth methods are composable plugins. Top-level entries in `auth_methods` are AND'd together. An `{ any_of: [...] }` entry creates an OR group where the agent must satisfy at least one method in the group.

Example: `["invite_code", { "any_of": ["email_code", "sms_code"] }]` requires an invite code AND either email or SMS verification.

```mermaid
graph TB
    subgraph "Implemented"
        Open["open<br/>No challenge, immediate ready"]
        EmailCode["email_code<br/>6-digit code via email"]
        InviteCode["invite_code<br/>Single-use pre-issued codes"]
        AgentWL["agent_allow_list<br/>Pre-approved agent keys<br/>sign nonce to prove identity"]
        HcApproval["hc_auth_approval<br/>Operator/KYC approval via<br/>hc-auth server polling"]
    end

    subgraph "Planned"
        SMS["sms_code<br/>6-digit code via SMS"]
        EVM["evm_signature<br/>EVM wallet signature"]
        Solana["solana_signature<br/>Solana wallet signature"]
        Custom["x-custom<br/>Operator-defined methods"]
    end

    Interface["AuthMethodPlugin Interface<br/>━━━━━━━━━━━━━<br/>type: string<br/>createChallenges(agentKey, claims, config)<br/>verifyChallengeResponse(challenge, response, claims)"]

    Open -.->|implements| Interface
    EmailCode -.->|implements| Interface
    InviteCode -.->|implements| Interface
    AgentWL -.->|implements| Interface
    HcApproval -.->|implements| Interface
    SMS -.->|implements| Interface
    EVM -.->|implements| Interface
    Solana -.->|implements| Interface
    Custom -.->|implements| Interface

    style SMS fill:#555,color:#ccc,stroke-dasharray: 5 5
    style EVM fill:#555,color:#ccc,stroke-dasharray: 5 5
    style Solana fill:#555,color:#ccc,stroke-dasharray: 5 5
    style Custom fill:#555,color:#ccc,stroke-dasharray: 5 5
```

---

## Reconnect Flow

Separate from joining. For agents that have already joined but need fresh linker URLs (e.g., after URL expiration or network reconnection), and for an agent that joined and crashed before provisioning -- reconnect hands back that network's session token so it can call `/provision` without a second, 409-rejected join.

```mermaid
sequenceDiagram
    participant Agent as Browser Extension
    participant JS as Joining Service

    Note over Agent: Previously joined,<br/>linker URL expired or<br/>provision never completed

    Agent->>Agent: Generate ISO 8601 timestamp
    Agent->>Agent: Sign timestamp with agent's Ed25519 key

    Agent->>JS: POST /v1/reconnect<br/>{agent_key, timestamp, signature, network?}

    JS->>JS: Verify Ed25519 signature
    JS->>JS: Check timestamp within tolerance (default 5 min)
    JS->>JS: Look up ready session scoped to network
    JS-->>Agent: {linker_urls, http_gateways, session?}

    Note over Agent: Reconnect to new linker URL,<br/>or call /provision if session came back
```

No re-authentication required. The agent proves identity by signing a timestamp with their agent key; `network` is unsigned since it only selects among that agent's own already-authenticated sessions.
