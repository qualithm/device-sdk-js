# Device SDK

[![CI](https://github.com/qualithm/device-sdk-js/actions/workflows/ci.yaml/badge.svg)](https://github.com/qualithm/device-sdk-js/actions/workflows/ci.yaml)
[![codecov](https://codecov.io/gh/qualithm/device-sdk-js/graph/badge.svg)](https://codecov.io/gh/qualithm/device-sdk-js)
[![npm](https://img.shields.io/npm/v/@qualithm/device)](https://www.npmjs.com/package/@qualithm/device)

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
  claimCode: process.env.QUALITHM_CLAIM_CODE
})

device.onState((state) => console.log("state:", state))

await device.connect()
await device.publish(
  "telemetry",
  JSON.stringify({ ts: Date.now(), metrics: { temperature: 21.4 } })
)
```

The platform stores readings published to the `telemetry` topic as `{ ts, metrics }`: `ts` is the
reading time in epoch milliseconds, and `metrics` maps each metric name to a number. Other topics
reach the gateway but aren't stored as readings.

On first boot the SDK exchanges the claim code at `POST /provision/claim` and persists the returned
credential. On every subsequent boot it loads the stored credential and skips claiming — claim codes
are single-use, so a power cycle never re-claims.

### Environments and the gateway

Set `provisioningUrl` to the API of the environment the claim code came from:

| Environment | `provisioningUrl`               |
| ----------- | ------------------------------- |
| Production  | `https://api.qualithm.com`      |
| Test        | `https://api.test.qualithm.com` |

You don't configure the MQTT gateway. The claim response names the gateway for the device's zone,
and the SDK stores it with the credential, so every later boot connects to the same gateway.
`GET /zones` on the same API lists each zone's gateway.

To connect somewhere else, such as a local broker, set `broker.host` (and `broker.port`). A
configured host always wins over the claimed one. A credential stored by an SDK version before the
claimed broker has none, so it needs `broker.host` or a fresh claim.

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
import { Device } from "@qualithm/device"

const device = new Device({
  provisioningUrl: "https://api.qualithm.com",
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

For onboarding without a terminal — the companion-app flow — the device serves the claim exchange
itself. While no credential is stored, `startProvisioning()` brings up the setup access point
through an `AccessPointController` and serves the exchange on it. On a NetworkManager host such as
Raspberry Pi OS, `createNmcliAccessPoint` is that controller. A successful claim persists the
credential, drops the AP, and hands off to `connect()`:

```ts
import { createNmcliAccessPoint, Device } from "@qualithm/device"

const device = new Device({
  provisioningUrl: "https://api.qualithm.com",
  name: "field-gateway"
})

await device.startProvisioning({
  accessPoint: createNmcliAccessPoint({ ssid: "qualithm-setup-field-gateway" }),
  onProvisioned: () => device.connect()
})
```

The companion app joins the setup network, reads `GET /provision/info`, and posts the claim code to
`POST /provision/claim`. The server never runs alongside a gateway session: it refuses to start once
a credential exists, and a successful claim stops it before the MQTT session opens. A failed claim
(bad code, unreachable platform) leaves the server running, so onboarding can be retried.

A single-radio device can't reach the platform while it hosts the setup network. Supply a
`HomeNetworkController` as `homeNetwork`, and the companion app sends the home Wi-Fi `ssid` and
`passphrase` with the claim code. The device answers `202 { "status": "joining" }`, drops the access
point, joins the home network, then claims from there. If the join or the claim fails, it forgets
the network and brings the access point back, so onboarding restarts. The companion app learns the
device's identity from the platform, not from the setup network.

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

## License

Apache-2.0
