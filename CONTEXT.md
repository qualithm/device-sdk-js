---
status: active
updated: 2026-06-26
---

# Project context

> Why `@qualithm/device` is the way it is — intent, direction, and the decisions future work builds
> on. The README says _what_ it is and _how_ to use it; this file says _why_. This SDK is one
> surface of the cross-cutting **Device access / authentication** initiative — see
> [`dx/initiatives/device-auth.md`](../dx/initiatives/device-auth.md).

## Intent

Give device firmware a one-call `connect()` that hides the whole secure-onboarding dance: claim-code
exchange, per-device credential persistence, MQTT-over-TLS, and rotation. The goal is **easy +
secure** — a maker or a CI job gets a working, authenticated, tenant-scoped device session without
having to understand provisioning, TLS, or credential rotation.

## Direction

The SDK is the client surface of the device-auth initiative (tracking issue: qualithm/platform#95,
`Initiative: Device auth` on the Engineering board). It trails the platform provisioning/lifecycle
work; the trackable plan lives on the board.

- **Now:** the token path — claim-code exchange → per-device token → MQTT-over-TLS — with crash-safe
  credential persistence, auto-reconnect, and ECDSA CSR generation for the certificate path.
- **Next:** the mTLS certificate path end-to-end (CSR → signed cert → mTLS connect), fleet
  provisioning helpers, and a thin CLI.

## Load-bearing assumptions

1. **The platform Device-Provisioning endpoint mints a per-device credential from a claim code.**
   `connect()` depends on that exchange contract (device-auth Phase 6).
2. **Credential persistence survives power-cycles.** A device that reboots re-uses its stored
   credential rather than re-claiming.

## Key decisions

- **One-call `connect()`** hides TLS + bootstrap + rotation — the SDK's whole reason to exist.
- **Crash-safe credential store** — the minted credential is persisted before first use, so a
  power-cycle mid-provision can't strand the device.
- **Two auth paths** — token (default, simplest) and mTLS certificate (CSR generated client-side;
  the private key never leaves the device). Mirrors the platform authenticator's token/cert split.
