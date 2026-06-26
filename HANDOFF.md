---
updated: 2026-06-26
---

# Handoff

> The live working state for a fresh contributor or agent: **what's done, what's in progress, and
> exactly where to start.** Keep it SMALL and current — replace the snapshot each working session.
> Completed-work history → `CHANGELOG.md`; the forward plan → the Engineering board (Device-auth
> initiative); the durable _why_ → [`CONTEXT.md`](CONTEXT.md).

## Snapshot (2026-06-26)

- **Branch:** `development` — initial SDK committed (`feat: initial @qualithm/device SDK`).
- **Done:** one-call `connect()` token path — claim-code exchange, crash-safe credential
  persistence, MQTT-over-TLS session with auto-reconnect, and ECDSA CSR generation for the
  certificate path. Bun-lib toolchain + CI archetype in place.
- **In progress:** —
- **Next step:** wire the **mTLS certificate path end-to-end** (CSR → signed cert → mTLS connect)
  against the platform provisioning endpoint ← start here.
- **Blockers / watch-outs:** depends on the platform claim/provisioning API (device-auth Phase 6);
  keep in lockstep with [`dx/initiatives/device-auth.md`](../dx/initiatives/device-auth.md).

## Maintaining this file

Replace the snapshot each session — don't append. When a chunk of work completes, move its notes to
`CHANGELOG.md` and trim this back to the present. Forward plan lives on the board; the durable _why_
lives in `CONTEXT.md`.
