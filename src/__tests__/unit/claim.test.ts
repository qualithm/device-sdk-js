import { afterEach, describe, expect, it, vi } from "vitest"

import { claimDevice } from "../../claim.js"
import { ClaimError } from "../../errors.js"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("claimDevice", () => {
  it("maps a successful claim into a token credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { deviceId: "d", spaceId: "s", teamId: "t", secret: "qmd_abc" }
      })
    )

    const credential = await claimDevice("https://api.example.com/", { code: "qmc_x.y" })

    expect(credential.deviceId).toBe("d")
    expect(credential.kind).toBe("token")
    expect(credential.token).toBe("qmd_abc")
  })

  it("throws ClaimError on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "nope" }, 401))

    await expect(claimDevice("https://api.example.com", { code: "bad" })).rejects.toBeInstanceOf(
      ClaimError
    )
  })

  it("throws ClaimError when the endpoint is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))

    await expect(claimDevice("https://api.example.com", { code: "x" })).rejects.toBeInstanceOf(
      ClaimError
    )
  })
})
