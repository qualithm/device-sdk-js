import { describe, expect, it } from "vitest"

import { Device } from "../../device.js"
import { CredentialError } from "../../errors.js"
import { createMemoryCredentialStore } from "../../store.js"

describe("Device", () => {
  it("starts idle with no identity", () => {
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      store: createMemoryCredentialStore()
    })

    expect(device.connectionState).toBe("idle")
    expect(device.identity).toBeNull()
  })

  it("fails to connect without a stored credential or claim code", async () => {
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      store: createMemoryCredentialStore()
    })

    await expect(device.connect()).rejects.toBeInstanceOf(CredentialError)
  })
})
