import { describe, expect, it } from "vitest"

import {
  createRecordingCredentialStore,
  createTestCredential,
  testFixtures
} from "../../testing/index.js"

describe("createRecordingCredentialStore", () => {
  it("records calls in order and round-trips credentials", async () => {
    const store = createRecordingCredentialStore()

    expect(await store.load()).toBeNull()
    const credential = createTestCredential()
    await store.save(credential)
    expect((await store.load())?.deviceId).toBe(credential.deviceId)
    await store.clear()

    expect(store.calls.map((call) => call.op)).toEqual(["load", "save", "load", "clear"])
    store.clearCalls()
    expect(store.calls).toHaveLength(0)
  })
})

describe("createTestCredential", () => {
  it("applies overrides over the default token credential", () => {
    const credential = createTestCredential({ token: "qmd_custom" })

    expect(credential.token).toBe("qmd_custom")
    expect(credential.kind).toBe("token")
  })
})

describe("testFixtures", () => {
  it("provides usable credential fixtures", () => {
    expect(testFixtures.credentials.length).toBeGreaterThan(0)
    expect(testFixtures.credentials[0]?.credential.deviceId).toBeDefined()
  })
})
