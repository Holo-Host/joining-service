# Holo Joining Service

[![npm: @holo-host/joining-service](https://img.shields.io/npm/v/@holo-host/joining-service)](https://www.npmjs.com/package/@holo-host/joining-service)
[![License: CAL-1.0](https://img.shields.io/badge/License-CAL--1.0-blue.svg)](./LICENSE)

> [!WARNING]
> **Alpha software.** The joining service is under active development. APIs may change between releases. Not yet recommended for production use.

Standardized REST API for onboarding agents into Holochain apps.

## What This Is

A per-hApp service that brokers the data a Holochain client needs to connect a new agent to a network. Each capability is independently optional; deploy only what your hApp requires:

- **Membrane proofs** — cryptographic authorization to join (per-hApp, per-DNA)
- **HTTP gateways** — read-only access before the agent has joined
- **Linker URLs** — relay servers for browser-based nodes (HWC / Holo-specific)
- **hApp bundles** — the application WASM and manifest URL

This service is not HWC-specific. It works for any Holochain deployment context: browser-based nodes that need linker relay URLs, native nodes that only need membrane proofs, gateway-only read access, or any combination.

## Documents

- [JOINING_SERVICE_API.md](./JOINING_SERVICE_API.md) — Full REST API specification
- [DELEGATED_VERIFICATION.md](./DELEGATED_VERIFICATION.md) — Delegated verification setup and configuration
- [CLI.md](./CLI.md) — `joining-cli` tool for headless node provisioning (membrane proofs, hc-auth, roles-settings YAML)
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Node types the service supports, flow diagrams, and configuration profiles
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Deployment guide (local, Cloudflare Workers, edge node)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Development setup, code standards, and how to contribute

## Quick Summary

```
Agent starts up
  → GET /.well-known/holo-joining         (auto-discover joining service)
  → GET /v1/info                           (gateways, auth methods, linker info)
  → POST /v1/join                          (agent key + identity claims)
  → POST /v1/join/{session}/verify         (if verification required)
  → GET /v1/join/{session}/provision     (membrane proof, linker URLs, bundle URL)
  → Install hApp, connect to network
```

All fields in the provision response are optional. A minimal deployment serving only membrane proofs returns just `membrane_proofs`. A gateway-only deployment returns only `http_gateways` from `/v1/info`.

## Client Library

`@holo-host/joining-service/client` exports `JoiningClient`, the reference client for the flow above. It has no Holochain dependency: the caller supplies the agent key as base64 (`uhCAk...`, i.e. `encodeHashToBase64()` output) and, for recovery, a callback that signs with it.

### Constructing a client

Which constructor you use depends on whether the app domain publishes a well-known document.

**Discovery.** For an app served from a domain hosting `/.well-known/holo-joining`, which is the usual case for a web app. It is also the only constructor that can route to a network on its own:

```ts
import { JoiningClient } from '@holo-host/joining-service/client';

const client = await JoiningClient.discover('app.example.com');
const info = await client.getInfo(); // auth methods, gateways, linker info
```

`discover()` keeps the `happ_id` from the well-known document and sends it as `network` on `join()`, so a service hosting several networks routes the join without the caller threading the id through. The document's `happ_id` must therefore name either the service's static `happ.id` or a network registered with it. Otherwise a bare `join()` fails with 400 `unknown_network`.

**Direct URL.** For when you already know the service URL and there is no well-known document to read: headless nodes, tests, or an app deliberately pointed at one service.

```ts
const client = JoiningClient.fromUrl('https://joining.example.com/v1');
const info = await client.getInfo();
```

With no discovered `happ_id`, this client's `join()` sends no `network` and lands on the service's statically configured network. To reach a registered network from here, name it explicitly (below).

### Choosing a network

`join()`'s third argument selects the network. It takes three forms:

```ts
// Discovered network: sends the well-known document's happ_id.
// Only meaningful on a client built with discover().
await client.join(agentKey, claims);

// Explicit network: overrides discovery, and is the only way to
// name a registered network on a fromUrl() client.
await client.join(agentKey, claims, 'acme-net');

// No network: suppresses the discovered id and sends none, landing on
// the service's own statically configured network.
await client.join(agentKey, claims, null);
```

Naming the service's own `happ.id` explicitly is the same as sending none; the server treats both as its static network.

### Join and provision

`join()` returns an immutable `JoinSession`. Each `verify()` and `pollStatus()` call returns the next one, so drive the flow off the returned value rather than the original:

```ts
let session = await client.join(agentKey, { email: 'user@example.com' });

while (session.status === 'pending') {
  const challenge = session.challenges?.[0];
  session = challenge
    ? await session.verify(challenge.id, await promptUser(challenge))
    : await session.pollStatus(); // server-side gates (e.g. hc_auth_approval)
}
if (session.status === 'rejected') throw new Error(session.reason);

const provision = await session.getProvision();
```

Every field of the provision is optional, and which ones arrive depends on how the service is deployed. Branch on what is present:

```ts
// A service that manages linker relays returns linker_urls. A
// membrane-proof-only or gateway-only deployment omits it entirely,
// so treat an absent value as a normal response.
if (provision.linker_urls?.length) {
  await connectViaLinker(provision.linker_urls);
}
if (provision.roles) {
  await install(provision.roles, provision.happ_bundle_url);
}
```

The same holds for `/v1/info`: `linker_info` is absent when the service does not manage linker URLs, so check it before offering a linker-related choice to the user.

### Recovery

An agent that joined and then crashed before installing cannot join again: `POST /v1/join` answers `409 agent_already_joined`. `reconnect(agentKey, signTimestamp, network?)` recovers the session token by proving key possession instead, and `reconnectAndProvision(agentKey, signTimestamp, network?)` does that and fetches the provision in one call. `signTimestamp` receives an ISO 8601 string and returns the raw ed25519 signature bytes; signing works before any app is installed, since the key is in lair as soon as `generateAgentPubKey` returns.

The `network` argument follows the same three forms as `join()`, and should match whichever the original join used.

The whole startup decision is local state plus at most one recovery attempt. `store`, `admin`, `sign`, `install`, and `joinAndInstall` below are the app's own; the client library supplies only the `JoiningClient` calls:

```ts
import { encodeHashToBase64 } from '@holochain/client';
import { JoiningClient, JoiningError } from '@holo-host/joining-service/client';

async function startup(client: JoiningClient, network?: string) {
  if (await store.happInstalled()) return; // nothing to join

  let agentKey = await store.agentKey();
  if (!agentKey) {
    agentKey = encodeHashToBase64(await admin.generateAgentPubKey());
    await store.setAgentKey(agentKey); // persist before joining, not after
    return joinAndInstall(client, agentKey, network);
  }

  // Key but no hApp: an interrupted install, or a first run that got this far.
  try {
    const { provision } = await client.reconnectAndProvision(agentKey, sign, network);
    if (provision) return install(provision);
  } catch (err) {
    if (!(err instanceof JoiningError && err.code === 'agent_not_joined')) throw err;
  }
  return joinAndInstall(client, agentKey, network);
}
```

Recovery is attempted first because it needs only the key and a signature, while `join()` may need claims or a prompt the user has to answer. Persisting the agent key before the join is what makes every crash after it recoverable; the reasoning, the three reconnect outcomes, and the wire-level detail are in [Client Integration](./JOINING_SERVICE_API.md#4-client-integration).

## Status

Alpha implementation complete. Reference server, client library, and E2E tests are in `src/` and `test/`.
