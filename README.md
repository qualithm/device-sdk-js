# Device SDK

<!-- TODO: uncomment badges after first publish
[![CI](https://github.com/qualithm/device-sdk-js/actions/workflows/ci.yaml/badge.svg)](https://github.com/qualithm/device-sdk-js/actions/workflows/ci.yaml)
[![codecov](https://codecov.io/gh/qualithm/device-sdk-js/graph/badge.svg)](https://codecov.io/gh/qualithm/device-sdk-js)
[![npm](https://img.shields.io/npm/v/@qualithm/device)](https://www.npmjs.com/package/@qualithm/device)
-->

Device provisioning and connectivity SDK for JavaScript and TypeScript runtimes. It hides the device
lifecycle behind a single `connect()` call — claim once, persist the credential, and maintain an
auto-reconnecting MQTT-over-TLS session — on Node, Bun, and Deno.

## Features

- **One-call `connect()`** — claim a device, persist its credential, and open an MQTT-over-TLS
  session in a single call.
- **Restart-safe** — an idempotent state machine that claims once and reuses the stored credential
  across reboots and power cycles.
- **Crash-safe credential store** — atomic, `fsync`-backed persistence with a pluggable backend for
  constrained or hardened targets.
- **Token and certificate paths** — bearer-token auth out of the box, plus on-device key + CSR
  generation for the mTLS certificate path.
- **Runtime-agnostic** — runs on Node 20+, Bun, and Deno using only standard Web and Node APIs.

## Installation

```bash
bun add @qualithm/device
# or
npm install @qualithm/device
```

## Quick Start

```ts
import { Device } from "@qualithm/device"

const device = new Device({
  provisioningUrl: "https://api.qualithm.com",
  broker: { host: "gw.de-fra-a.qualithm.com" },
  claimCode: process.env.QUALITHM_CLAIM_CODE
})

device.onState((state) => console.log("state:", state))

await device.connect()
await device.publish("telemetry/temperature", JSON.stringify({ c: 21.4 }))
```

On first boot the SDK exchanges the claim code at `POST /provision/claim` and persists the returned
credential. On every subsequent boot it loads the stored credential and skips claiming — claim codes
are single-use, so a power cycle never re-claims.

## Usage

### Restart & power-cycle resilience

- **Idempotent `connect()`** — inspects persisted state and only claims when no credential exists;
  otherwise it connects directly.
- **Crash-safe credential store** — the default file store writes to a temp file, `fsync`s, then
  atomically renames, so a power loss mid-write cannot corrupt the credential.
- **Automatic reconnect** — transport reconnection and backoff are handled by the underlying MQTT
  client; subscriptions are re-established on resume.
- **Pluggable storage** — supply your own `CredentialStore` (flash/NVS, secure element, keychain)
  for constrained or hardened targets.

### Certificate (mTLS) path

The device generates its own key pair and CSR; an operator mints the certificate, which the device
then stores and connects with:

```ts
import { generateDeviceCsr } from "@qualithm/device"

const { privateKeyPem, csrPem } = await generateDeviceCsr(deviceId)
// Submit csrPem to the operator mint flow, then persist the returned
// certificate alongside privateKeyPem as a `cert` credential.
```

### Error Handling

All errors extend `QualithmDeviceError`; each subclass exposes a static `isError()` for
`instanceof`-free narrowing.

```ts
import { ClaimError, CredentialError } from "@qualithm/device"

try {
  await device.connect()
} catch (error) {
  if (CredentialError.isError(error)) {
    // missing or unreadable credential
  } else if (ClaimError.isError(error)) {
    // claim code rejected or endpoint unreachable
  } else {
    throw error
  }
}
```

## API Reference

Full API documentation is generated with [TypeDoc](https://typedoc.org/):

```bash
bun run docs
# Output in docs/
```

## Examples

See the [`examples/`](examples/) directory for runnable examples:

| Example                                                           | Description                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| [`basic-usage.ts`](examples/basic-usage.ts)                       | Configure a device, generate a CSR, claim + connect    |
| [`error-handling.ts`](examples/error-handling.ts)                 | Typed error hierarchy and `isError()` narrowing        |
| [`credential-persistence.ts`](examples/credential-persistence.ts) | Crash-safe file store; reuse the credential on restart |

```bash
bun run examples/basic-usage.ts
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) (recommended), Node.js 20+, or [Deno](https://deno.land/)

### Setup

```bash
bun install
```

### Building

```bash
bun run build
```

### Testing

```bash
bun run test              # unit tests
bun run test:integration  # integration tests
bun run test:coverage     # with coverage report
```

### Linting & Formatting

```bash
bun run lint
bun run format
bun run typecheck
```

### Benchmarks

```bash
bun run bench
```

## Publishing

The package is automatically published to NPM when CI passes on main. Update the version in
`package.json` before merging to trigger a new release.

## License

Apache-2.0

## CI & Branch Protection

The `.github/workflows/ci.yaml` workflow and the `main` / `test` branch rulesets are generated by
[dx](https://github.com/qualithm/dx). To change CI for this repo, edit the relevant archetype in
`dx/ci-templates/` and run `dx ci sync`; do not edit `ci.yaml` directly. The umbrella job at the end
of the workflow supplies the single required status check (`CI Required`).
