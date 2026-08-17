# joining-cli — Headless Node Provisioning

Command-line tool for provisioning headless Holochain nodes that run without a UI. Handles the full joining flow (membrane proofs), hc-auth authentication (conductor auth material), and outputs files that `hc sandbox call install-app` can consume directly.

## Prerequisites

- **holo-keyutil** — Rust binary that signs data via a running lair-keystore instance. The lair passphrase is read from stdin (never passed as a CLI argument) to avoid leaking it in process listings. Source is in `holo-keyutil/` in this repo. Build with `cargo build --release` and place the binary in PATH (or use `--keyutil-bin` to specify its location).
- **lair-keystore** — Must be running and accessible via IPC URL. The conductor's lair instance is used so that signing happens with the same keys the conductor uses.
- **hc** — Holochain CLI, used to generate agent keys and install apps on the conductor.

## Commands

### `joining-cli provision`

Drives the full join flow against a joining service and outputs a `roles-settings.yaml` file that can be passed to `hc sandbox call install-app --roles-settings`.

```
joining-cli provision [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--service-url <url>` | Joining service base URL |
| `--discover <domain>` | Auto-discover service via `.well-known/holo-joining`. The document's `happ_id` becomes the default `--network` when `--network` is not also given (harmless when it's the statically configured network's own happ_id -- the server treats that the same as no network). |
| `--agent-key <key>` | AgentPubKey in HoloHash format (`uhCAk...`) |
| `--lair-url <url>` | Lair IPC connection URL (required for `agent_allow_list` auth) |
| `--lair-passphrase-file <path>` | File containing lair passphrase (or set `LAIR_PASSPHRASE` env) |
| `--keyutil-bin <path>` | Path to `holo-keyutil` binary (default: searches PATH) |
| `--invite-code <code>` | Invite code for gated networks (or set `INVITE_CODE` env) |
| `--email <address>` | Email address for `email_code` auth |
| `--network <id>` | happ_id of a registered network to join (see JOINING_SERVICE_API.md Section 3.11 for registration). Determines which network's `roles`/membrane proofs the session receives at provision. Omit to join the statically configured network's roles; naming that network's own happ_id has the same effect. |
| `--output <path>` | Write output to file (default: stdout) |
| `--format <yaml\|json>` | Output format (default: `yaml`) |
| `--poll-timeout <seconds>` | Max wait for async challenges like admin approval (default: 300) |
| `--quiet` | Suppress progress messages on stderr |

**Flow:**

1. Calls `POST /v1/join` with agent key and claims
2. If `agent_allow_list` challenge is returned, auto-signs the nonce via lair (no human interaction)
3. If `invite_code` is provided, it is auto-verified at join time
4. Polls for approval if challenges are still pending (e.g. external admin approval)
5. Calls `GET /v1/join/{session}/provision` to get membrane proofs
6. Outputs roles-settings YAML (or JSON)

**YAML output format** (for `hc sandbox call install-app --roles-settings`):

```yaml
my-role:
  type: provisioned
  membrane_proof: "base64-encoded-proof..."
  modifiers:
    network_seed: abc123
other-role:
  type: provisioned
  membrane_proof: "base64-encoded-proof..."
```

Role names in the output — along with their DNA hashes and modifiers — come from whichever network the session joined:

- **With `--network <happ_id>`** (or a `--discover` document whose `happ_id` names a registered network): from that network's registration record. The service's own static `roles` are not consulted, and the bundle URL is the network's own `happ.happ_bundle_url` with no fallback to the service's.
- **Without a network**: from the service's static `roles` config (see [Service Configuration](#service-configuration)).

If the named network is unregistered by the time provisioning runs — deleted between join and provision — the CLI fails with `404 unknown_network` rather than silently falling back to the static roles.

---

### `joining-cli hc-auth authenticate`

Generates auth material for the conductor config by performing the agent-side hc-auth flow: `GET /now` (fetch challenge) -> sign with lair -> `PUT /authenticate`.

This is similar to the bash polling loop in the heart repo's `holochain-register` script.

```
joining-cli hc-auth authenticate [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--hc-auth-url <url>` | hc-auth server base URL |
| `--agent-key <key>` | AgentPubKey in HoloHash format |
| `--lair-url <url>` | Lair IPC connection URL |
| `--lair-passphrase-file <path>` | Lair passphrase file (or `LAIR_PASSPHRASE` env) |
| `--keyutil-bin <path>` | Path to `holo-keyutil` binary |
| `--output-format <fmt>` | `base64` (default), `json`, or `conductor-yaml-patch` |
| `--output <path>` | Write to file instead of stdout |

**Output formats:**

- `base64` — Just the base64-encoded auth material string, suitable for scripted insertion into conductor config
- `json` — The full auth body (`{"pubKey": "...", "payload": "...", "signature": "..."}`)
- `conductor-yaml-patch` — A YAML line: `base64_auth_material: "..."`

**Requires** the agent to already be authorized on the hc-auth server (either via the joining service's automatic `registerAndAuthorize`, or via manual `joining-cli hc-auth register`).

---

### `joining-cli hc-auth check`

Read-only diagnostic. Checks connectivity to the hc-auth server and reports the agent's current state.

```
joining-cli hc-auth check [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--hc-auth-url <url>` | hc-auth server base URL |
| `--hc-auth-token <token>` | Admin API bearer token (or `HC_AUTH_TOKEN` env) |
| `--agent-key <key>` | AgentPubKey in HoloHash format |

**Example output:**

```
hc-auth server: https://hc-auth-iroh.holochain.org
  connectivity: ok
  agent uhCAk71wNXTv7ls...: authorized
```

---

### `joining-cli hc-auth register`

Admin-side operation. Registers an agent key and immediately transitions it to `authorized` state. Idempotent.

```
joining-cli hc-auth register [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--hc-auth-url <url>` | hc-auth server base URL |
| `--hc-auth-token <token>` | Admin API bearer token (or `HC_AUTH_TOKEN` env) |
| `--agent-key <key>` | AgentPubKey in HoloHash format |

---

## Service Configuration

Role-keyed YAML requires the session's network to declare `roles`. That comes from one of two places, and a service may use either or both.

**Static roles** — the service's own network, used when `provision` runs without `--network`:

```json
{
  "roles": {
    "my-role": {
      "dna_hash": "uhC0k...",
      "modifiers": {
        "network_seed": "my-network",
        "properties": { "progenitor_pubkey": "uhCAk..." }
      }
    },
    "other-role": {
      "dna_hash": "uhC0k..."
    }
  }
}
```

**Registered networks** — declared per network at registration time, used when `provision` names one with `--network`. The `roles` object has the same shape as above; see JOINING_SERVICE_API.md Section 3.11 for `POST /v1/admin/networks`. A service configured with `network_registration` and no static `roles` at all is a supported deployment: it has no network of its own, and every `provision` against it must pass `--network`.

In both cases `dna_hash` is required per role only when the service has `membrane_proof.enabled` — it binds the membrane proof to a DNA. Without membrane proofs, a role needs only its `modifiers`.

---

## End-to-End Provisioning Example

Full script for provisioning a headless node after the conductor is running:

```bash
#!/bin/bash
set -eo pipefail

ADMIN_PORT=4444
SERVICE_URL=https://joining.example.com
HC_AUTH_URL=https://hc-auth-iroh.holochain.org
LAIR_URL=$(lair-keystore --lair-root /var/lib/holochain/lair url)
LAIR_PW_FILE=/var/lib/holochain/lair-passphrase
CONFIG_FILE=/etc/holochain/conductor-config.yaml

# 1. Generate agent key on the running conductor
AGENT_KEY=$(hc s call -r $ADMIN_PORT new-agent | jq -r '.')
echo "Agent key: $AGENT_KEY"

# 2. Get membrane proofs from joining service
#    The joining service also calls registerAndAuthorize on hc-auth as
#    part of the join flow, so the agent will be authorized after this.
#    Add --network <happ_id> to provision against a registered network
#    instead of the service's own; its roles come from that registration.
joining-cli provision \
  --service-url $SERVICE_URL \
  --agent-key "$AGENT_KEY" \
  --lair-url "$LAIR_URL" \
  --lair-passphrase-file $LAIR_PW_FILE \
  --invite-code "$INVITE_CODE" \
  --output /tmp/roles-settings.yaml

# 3. Generate auth material for conductor config
#    The agent is already authorized (step 2), so this will succeed.
AUTH_MATERIAL=$(joining-cli hc-auth authenticate \
  --hc-auth-url $HC_AUTH_URL \
  --agent-key "$AGENT_KEY" \
  --lair-url "$LAIR_URL" \
  --lair-passphrase-file $LAIR_PW_FILE)

# 4. Patch conductor config and restart
sed -i "s|base64_auth_material:.*|base64_auth_material: \"${AUTH_MATERIAL}\"|" \
  "$CONFIG_FILE"
# Restart conductor (s6, systemd, etc.)

# 5. Install app with membrane proofs
hc s call -r $ADMIN_PORT install-app \
  --roles-settings /tmp/roles-settings.yaml \
  /path/to/app.happ

rm /tmp/roles-settings.yaml
echo "Provisioning complete"
```

### Subsequent boots (auth material refresh)

On restart, the conductor needs fresh auth material but the agent key already exists. Only step 3-4 need to repeat:

```bash
AGENT_KEY=$(cat /var/lib/holochain/agent-pub-key)
AUTH_MATERIAL=$(joining-cli hc-auth authenticate \
  --hc-auth-url $HC_AUTH_URL \
  --agent-key "$AGENT_KEY" \
  --lair-url "$LAIR_URL" \
  --lair-passphrase-file $LAIR_PW_FILE)
sed -i "s|base64_auth_material:.*|base64_auth_material: \"${AUTH_MATERIAL}\"|" \
  "$CONFIG_FILE"
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (auth rejected, network failure, etc.) |
| 3 | Invalid arguments |

---

## Building holo-keyutil

```bash
cd holo-keyutil
cargo build --release
cp target/release/holo-keyutil /usr/local/bin/
```

Requires Rust toolchain. The binary links against `lair_keystore_api` (must be compatible with the lair-keystore version running on the node) and `sodoken` for cryptographic operations.
