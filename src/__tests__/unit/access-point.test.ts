import { describe, expect, it } from "vitest"

import { createNmcliAccessPoint, hotspotCommands } from "../../access-point.js"

describe("hotspotCommands", () => {
  it("brings the hotspot up on the default interface", () => {
    const { up, down } = hotspotCommands({ ssid: "qualithm-setup-a1b2" })
    expect([...up]).toEqual([
      "device",
      "wifi",
      "hotspot",
      "ifname",
      "wlan0",
      "ssid",
      "qualithm-setup-a1b2"
    ])
    expect([...down]).toEqual(["connection", "delete", "qualithm-setup"])
  })

  it("honours a non-default interface", () => {
    const { up } = hotspotCommands({ ssid: "qualithm-setup-x", ifname: "wlan1" })
    expect(up).toContain("wlan1")
  })

  it("creates an open hotspot — the claim code, not Wi-Fi, is the secret", () => {
    const { up } = hotspotCommands({ ssid: "qualithm-setup-a1b2" })
    // No password argument: an open network so the companion can join before
    // any credential exists.
    expect(up).not.toContain("password")
  })
})

describe("createNmcliAccessPoint", () => {
  it("runs the up command on start and the down command on stop", async () => {
    const ran: string[][] = []
    const ap = createNmcliAccessPoint({ ssid: "qualithm-setup-a1b2" }, async (args) => {
      ran.push([...args])
      await Promise.resolve()
    })

    await ap.start()
    await ap.stop()

    expect(ran).toHaveLength(2)
    expect(ran[0]).toContain("hotspot")
    expect(ran[1]).toEqual(["connection", "delete", "qualithm-setup"])
  })

  it("stop is idempotent — a missing profile tears down without throwing", async () => {
    const ap = createNmcliAccessPoint({ ssid: "qualithm-setup-a1b2" }, async () => {
      await Promise.resolve()
      throw new Error("Unknown connection 'qualithm-setup'")
    })
    // A device that never hosted (or already removed the profile) stops cleanly
    // so an interrupted onboarding can restart.
    await expect(ap.stop()).resolves.toBeUndefined()
  })
})
