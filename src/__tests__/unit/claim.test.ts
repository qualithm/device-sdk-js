import { afterEach, describe, expect, it, vi } from "vitest"

import { claimDevice, parseBroker } from "../../claim.js"
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

  it("stores the broker the platform returns for the device's zone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          deviceId: "d",
          spaceId: "s",
          teamId: "t",
          secret: "qmd_abc",
          broker: { host: "gw.test-sg-sin-a.qualithm.com", port: 8883 }
        }
      })
    )

    const credential = await claimDevice("https://api.example.com", { code: "qmc_x.y" })

    expect(credential.broker).toEqual({ host: "gw.test-sg-sin-a.qualithm.com", port: 8883 })
  })

  it("leaves the broker unset when an older platform omits it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ data: { deviceId: "d", spaceId: "s", teamId: "t", secret: "qmd_abc" } })
    )

    const credential = await claimDevice("https://api.example.com", { code: "qmc_x.y" })

    expect(credential).not.toHaveProperty("broker")
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

describe("parseBroker", () => {
  it("accepts a host and port", () => {
    expect(parseBroker({ host: "gw.example.com", port: 8883 })).toEqual({
      host: "gw.example.com",
      port: 8883
    })
  })

  it("ignores a missing or malformed broker", () => {
    for (const value of [
      undefined,
      null,
      "gw.example.com",
      { host: "", port: 8883 },
      { host: "gw.example.com" },
      { host: "gw.example.com", port: "8883" },
      { host: "gw.example.com", port: 0 },
      { host: "gw.example.com", port: 65536 },
      { host: "gw.example.com", port: 88.5 }
    ]) {
      expect(parseBroker(value)).toBeUndefined()
    }
  })
})
