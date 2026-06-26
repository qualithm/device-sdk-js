import { afterEach, describe, expect, it, vi } from "vitest"

import { claimDevice } from "../../claim.js"
import { createMemoryCredentialStore } from "../../store.js"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("provisioning integration", () => {
  it("claims a credential and persists it for reuse across restarts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { deviceId: "d", spaceId: "s", teamId: "t", secret: "qmd_x" }
      })
    )
    const store = createMemoryCredentialStore()

    // First boot: nothing stored → claim and persist.
    expect(await store.load()).toBeNull()
    const credential = await claimDevice("https://api.example.com", { code: "qmc_x.y" })
    await store.save(credential)

    // Simulated restart: the stored credential is reused, no re-claim.
    const reloaded = await store.load()
    expect(reloaded?.deviceId).toBe("d")
    expect(reloaded?.token).toBe("qmd_x")
    expect(reloaded?.kind).toBe("token")
  })
})
