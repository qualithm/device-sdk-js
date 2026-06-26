import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createFileCredentialStore, createMemoryCredentialStore } from "../../store.js"
import type { DeviceCredential } from "../../types.js"

const sample: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "t",
  spaceId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: new Date().toISOString()
}

describe("memory store", () => {
  it("roundtrips and clears", async () => {
    const store = createMemoryCredentialStore()
    expect(await store.load()).toBeNull()
    await store.save(sample)
    expect((await store.load())?.token).toBe("qmd_secret")
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})

describe("file store", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmt-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns null when no credential exists", async () => {
    const store = createFileCredentialStore(join(dir, "nested", "credential.json"))
    expect(await store.load()).toBeNull()
  })

  it("persists atomically (creating parent dirs) and reloads", async () => {
    const store = createFileCredentialStore(join(dir, "nested", "credential.json"))
    await store.save(sample)
    const loaded = await store.load()
    expect(loaded?.deviceId).toBe(sample.deviceId)
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})
