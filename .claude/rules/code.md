# Code conventions — @qualithm/device

The Qualithm device SDK for JavaScript/TypeScript runtimes (Node, Bun, Deno). It hides the device
lifecycle behind one `connect()` call: claim once, persist the credential, and keep an
auto-reconnecting MQTT-over-TLS session to the Qualithm gateway.

`bun run lint` enforces import order, type-only imports, naming and `type` over `interface`. Fix
what it flags; this file covers what it can't.

## Architecture

- **Runtime-agnostic.** Use only cross-runtime APIs: global `fetch`, global `crypto`/`crypto.subtle`
  (WebCrypto), and `node:` built-ins. Never `Bun.*`: the SDK must run on plain Node and Deno.
- **Entry points.** `src/index.ts` is the public barrel (`.`), `src/testing/` the `./testing`
  export, and `src/bin/` with `src/cli/` the `qualithm-device` binary. Anything a consumer imports
  goes through one of them.
- **`Device`** (`src/device.ts`) owns the `connect()` state machine
  (`idle → provisioning → connecting → connected → reconnecting`) and
  `publish`/`subscribe`/`disconnect` with the `onState`/`onMessage`/`onError` hooks. Claiming,
  enrollment, renewal, capabilities, credential stores and provisioning each live in their own
  module beside it.
- **Errors** extend `QualithmDeviceError` (`src/errors.ts`), each with a `tag` and a static
  `isError()` for `instanceof`-free narrowing. A new failure kind gets its own subclass there.
- **Credential stores** write crash-safely: temp file, `fsync`, then atomic `rename`.
- **Transport** is MQTT.js. The SDK never implements MQTT or TLS; it sets its own reconnect delay
  (exponential with jitter, `src/backoff.ts`) because MQTT.js retries on a fixed period.
- **Wire contract** (must match the platform gateway): the MQTT `clientId` is the device ID; the
  token path presents the secret as the MQTT password; the cert path connects with `key`/`cert` over
  mTLS. Device-facing topics are relative: the gateway derives the tenant-scoped subject from the
  verified identity.
- `src/csr.ts` imports `reflect-metadata` before `@peculiar/x509`.

## Public API

- Named exports, never default exports. Export types separately (`export type { MyType }`).
- `unknown` over `any`. Public members carry TSDoc (typedoc `requiredToBeDocumented`): parameters,
  return value, `@throws`.
- Error messages are lowercase, with no trailing punctuation, and carry context. Never swallow an
  error.

## TypeScript

- `erasableSyntaxOnly` is on (`tsconfig.node.json`): no constructor parameter-properties; declare
  fields and assign them in the body.
- ESLint is strict: explicit return types on exported functions; `eqeqeq` (no `!= null`, use
  `=== undefined` or `=== null`); `strict-boolean-expressions`; `no-confusing-void-expression`
  (brace arrow bodies that call void functions); wrap numbers in `String(...)` in templates.

## Layout

- Tests use Vitest under `src/__tests__/unit/` (integration under `src/__tests__/integration/`, the
  gateway wire-contract fixtures in `src/__tests__/wire/`), mirroring the source path. Name each
  test after the behavior it checks.
- `package.json` script variants use `:`, never `-`: `test:unit`, `test:integration`, `build:watch`,
  `lint:fix`.

## When code changes

A behavior change carries tests that cover its new lines (`dx coverage patch` checks them after the
coverage step). Update types, error messages and TSDoc that mention a changed shape in the same
change, and drop a dependency nothing imports any more. `bun run validate:runtime` checks the export
shape on Node, Bun and Deno.

## Comments

Implementation comments only for non-obvious logic. No architecture overviews, diagrams, feature
lists or how-to guides in comments; they go stale.

## Generated files

`.github/workflows/ci.yaml` is generated from `dx/ci-templates/`; change the template and run
`dx ci sync` from dx, never edit it here. `CI Required` and `PR Title` are required.

## Validate

See `.claude/rules/checks.md` (synced from dx) for the exact commands this repo's CI enforces.
