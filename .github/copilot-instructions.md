# Copilot instructions — @qualithm/device

The Qualithm device SDK for JavaScript/TypeScript runtimes (Node, Bun, Deno). It hides the device
lifecycle behind one `connect()` call: claim once, persist the credential, and maintain an
auto-reconnecting MQTT-over-TLS session to the Qualithm gateway.

## Architecture

- **Runtime-agnostic.** Use only cross-runtime APIs: global `fetch`, global `crypto`/`crypto.subtle`
  (WebCrypto), and `node:` built-ins (`node:fs/promises`, `node:path`). Do **not** use Bun-only APIs
  (`Bun.*`) — the SDK must run on plain Node and Pi-class Linux, not just Bun.
- **Modules** (`src/`):
  - `types.ts` — public types (`DeviceCredential`, `ConnectionState`, `CredentialStore`,
    `DeviceOptions`, `BrokerOptions`).
  - `errors.ts` — error hierarchy (`QualithmDeviceError` base + `ClaimError`, `CredentialError`,
    `ConnectionError`), each with a `tag` and static `isError()` for `instanceof`-free narrowing.
  - `store.ts` — `createFileCredentialStore` (crash-safe: temp file → `fsync` → atomic `rename`) and
    `createMemoryCredentialStore`.
  - `claim.ts` — `claimDevice()` exchanges a claim code at `POST /provision/claim` and shapes the
    response into a `DeviceCredential`.
  - `csr.ts` — `generateDeviceCsr()` (ECDSA P-256 key + PKCS#10 CSR via `@peculiar/x509`;
    `import "reflect-metadata"` must come first).
  - `device.ts` — the `Device` class: the `connect()` state machine
    (`idle → provisioning → connecting → connected → reconnecting`), plus
    `publish`/`subscribe`/`disconnect` and `onState`/`onMessage`/`onError`.
  - `index.ts` — the public barrel.
- **Transport** is the standard `mqtt` (MQTT.js) package; reconnection/backoff is delegated to it.
  We never implement an MQTT or TLS stack.
- **Wire contract** (must match the platform gateway): the MQTT `clientId` is the device UUID; the
  token path presents the secret as the MQTT password; the cert path connects with `key`/`cert` over
  mTLS. Device-facing topics are relative — the gateway derives the tenant-scoped subject from the
  verified identity.

## Conventions

- `erasableSyntaxOnly` is on (`tsconfig.node.json`): no constructor parameter-properties — declare
  fields and assign in the body.
- ESLint is strict: explicit return types on exported functions; separate `import type`; `eqeqeq`
  (no `!= null` — use `=== undefined`/`=== null`); `strict-boolean-expressions`;
  `no-confusing-void-expression` (brace arrow bodies that call void functions); wrap numbers in
  `String(...)` in templates.
- Public API members need TSDoc (typedoc `requiredToBeDocumented`).

## Validate

```sh
bun run typecheck    # tsc -p tsconfig.node.json --noEmit
bun run lint         # eslint .  (bun run lint:fix to autofix)
bun run format       # prettier --check .  (format:fix to write)
bun run test         # vitest run src/__tests__/unit
```
