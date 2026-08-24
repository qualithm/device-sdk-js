import { describe, expect, it } from "vitest"

import { hotspotCommands } from "../../access-point.js"

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
