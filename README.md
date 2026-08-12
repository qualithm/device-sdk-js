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
- **Command dispatch** — register a handler per capability key; the SDK subscribes `command/#`,
  decodes the payload, and routes a typed value.
- **Soft-AP onboarding** — serve the claim exchange on the device's own setup network, so the
  companion app provisions a device with no terminal in the loop.
- **Capability declaration** — the device publishes what it can do on connect, without hand-building
  the manifest JSON.
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

### Commands & capabilities

A device declares what it can do; the platform validates every command against that declaration
before sending it. Declare capabilities once — the manifest is published on every connect — and
register a handler per commandable key:

```ts
const device = new Device({
  provisioningUrl: "https://api.qualithm.com",
  broker: { host: "gw.de-fra-a.qualithm.com" },
  claimCode: process.env.QUALITHM_CLAIM_CODE,
  capabilities: [
    { key: "power", type: "onoff" },
    { key: "brightness", type: "range", min: 0, max: 100, unit: "percent" },
    { key: "reboot", type: "trigger" }
  ]
})

device.onCommand<boolean>("power", (value) => setRelay(value))
device.onCommand<number>("brightness", (value) => setBrightness(value))
device.onCommand("reboot", () => restart()) // a trigger arrives with no value

await device.connect() // publishes the manifest and subscribes command/#
```

A command arrives on `command/<key>` with a JSON object payload — `{"value": ...}`, or `{}` for a
trigger. A malformed payload or a value that does not fit the declared capability is reported
through `onError` and never reaches the handler. To change the capability set at runtime, call
`device.declareCapabilities([...])` again.

### Soft-AP provisioning

For onboarding without a terminal — the companion-app flow (Decision #280) — the device serves the
claim exchange itself. While no credential is stored, `startProvisioning()` brings up the setup
access point (via a deployment-supplied controller) and serves the exchange on it. A successful
claim persists the credential, drops the AP, and hands off to `connect()`:

```ts
const device = new Device({
  provisioningUrl: "https://api.qualithm.com",
  broker: { host: "gw.de-fra-a.qualithm.com" },
  name: "field-gateway"
})

await device.startProvisioning({
  accessPoint: nmcliSoftAp(), // deployment-supplied AP bring-up/teardown
  onProvisioned: () => device.connect()
})
```

The companion app joins the setup network, reads `GET /provision/info`, and posts the claim code to
`POST /provision/claim`. The server never runs alongside a gateway session: it refuses to start once
a credential exists, and a successful claim stops it before the MQTT session opens. A failed claim
(bad code, unreachable platform) leaves the server running, so onboarding can be retried.

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
| [`softap-provisioning.ts`](examples/softap-provisioning.ts)       | Serve the claim exchange on the device's setup network |

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
