# Contributing to Holo Joining Service

## Before You Code

1. Look at the sibling repositories for API surface and type definitions -- these are the source of truth for Holochain internals:
   - [holochain](https://github.com/holochain/holochain) (Holochain 0.6 conductor)
   - [holochain-client-js](https://github.com/holochain/holochain-client-js) (@holochain/client)
   - [h2hc-linker](https://github.com/holo-host/h2hc-linker) (linker relay)
   - [holo-web-conductor](https://github.com/holo-host/holo-web-conductor) (browser conductor)
2. Write your test before your implementation

## Getting Started

### Prerequisites

- Node.js 22+
- npm (not yarn, pnpm, or bun)
- Access to the `@holo-host/lair` package (currently linked from `../holo-web-conductor/packages/lair`)

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Run Tests

Both steps are required before submitting a PR. Vitest uses esbuild, which strips types without checking them -- a green test suite can still have type errors.

```bash
npm run typecheck
npm test
```

To run tests in watch mode:

```bash
npm run test:watch
```

### Development Server

```bash
npm run dev
```

Starts the server with hot reload via `tsx watch`.

## Project Layout

```
src/
  app.ts              # Hono route definitions
  server.ts           # HTTP server entry point
  config.ts           # Configuration schema and loading
  types.ts            # Shared type definitions
  auth-methods/       # Pluggable authentication strategies
  client/             # Client library for consuming the API
  email/              # Email transport implementations
  hc-auth/            # HC-Auth server integration
  linker-auth/        # Linker registration client
  membrane-proof/     # Membrane proof generation and signing
  session/            # Session storage backends
  urls/               # URL provider implementations
test/
  *.test.ts           # Unit tests
  e2e/                # End-to-end integration tests
deploy/
  cloudflare/         # Cloudflare Workers deployment
  edgenode/           # Docker-based edge node deployment
```

## Code Standards

### Type safety is load-bearing

Types in this project exist to catch real bugs -- wrong hash sizes, missing fields, shape mismatches at serialization boundaries. Suppressing type errors defeats the purpose.

1. **`as any` is a defect in production code.** If the type system can't express the shape, create a named type or interface that documents the actual shape. Never silence the compiler to make it build faster.
2. **`as unknown as T` requires a comment** explaining why the intermediate shapes are compatible. If you can't explain it, the cast is wrong.
3. **Never add `// @ts-ignore` or `// @ts-expect-error` without a ticket or TODO** linking to the upstream issue that makes it necessary.

### Test code is code

Type assertions in tests hide the exact class of bugs that types catch.

- For partial mocks: use `Pick<T, 'needed' | 'fields'>` or create typed test factory functions -- not `{} as any`.
- For return value assertions: define the expected return type and assert against it. `(result as any).field` means the test cannot catch a field rename or shape change.
- For global patching (`window`, `globalThis`): `as any` is acceptable with a one-line comment (e.g., `// browser global not in test types`).

### General

- Keep changes focused. Don't refactor surrounding code as part of an unrelated fix.
- Don't add features, error handling, or abstractions beyond what was requested.

## Key Documentation

- [JOINING_SERVICE_API.md](./JOINING_SERVICE_API.md) -- REST API specification
- [ARCHITECTURE.md](./ARCHITECTURE.md) -- System design and deployment profiles
- [DEPLOYMENT.md](./DEPLOYMENT.md) -- Deployment guide
- [CLI.md](./CLI.md) -- joining-cli tool for headless node provisioning

## Submitting Changes

1. Fork the repository and create a feature branch
2. Write tests for new functionality
3. Ensure `npm run typecheck && npm test` both pass
4. Keep commits focused and descriptive
5. Open a pull request against `main`

## License

By contributing, you agree that your contributions will be licensed under the [Cryptographic Autonomy License v1.0](./LICENSE).
