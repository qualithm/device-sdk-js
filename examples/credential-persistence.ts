/**
 * Credential persistence example.
 *
 * Demonstrates the crash-safe file credential store: atomic save, reload, and
 * how a restart reuses the stored credential instead of re-claiming.
 *
 * @example
 * ```bash
 * bun run examples/credential-persistence.ts
 * ```
 */

/* eslint-disable no-console */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFileCredentialStore, type DeviceCredential } from "@qualithm/device"

async function main(): Promise<void> {
  console.log("=== Credential Persistence ===\n")

  const dir = await mkdtemp(join(tmpdir(), "qualithm-example-"))
  const path = join(dir, "credential.json")
  const store = createFileCredentialStore(path)

  try {
    console.log("--- First boot: no credential ---")
    const first = await store.load()
    console.log(`  load → ${first === null ? "null (nothing stored yet)" : "credential present"}`)

    const credential: DeviceCredential = {
      deviceId: "11111111-1111-1111-1111-111111111111",
      teamId: "team-1",
      spaceId: "space-1",
      kind: "token",
      token: "qmd_persisted",
      issuedAt: new Date().toISOString()
    }
    await store.save(credential)
    console.log(`  saved credential atomically to ${path}`)

    console.log("\n--- Simulated restart: reuse the stored credential (no re-claim) ---")
    const reloaded = await store.load()
    console.log(`  load → device ${reloaded?.deviceId ?? "?"} (${reloaded?.kind ?? "?"} path)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log("\nDone.")
}

await main()
