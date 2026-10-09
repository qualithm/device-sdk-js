import { describe, expect, it } from "vitest"

import { ProvisioningError } from "../../errors.js"
import {
  createNmcliHomeNetwork,
  homeNetworkKeyfile,
  type KeyfileStore
} from "../../home-network.js"

const PASSPHRASE = "correct horse battery"

const fakeStore = (): KeyfileStore & { files: Map<string, string>; removed: string[] } => {
  const files = new Map<string, string>()
  const removed: string[] = []
  return {
    files,
    removed,
    write: async (path, contents) => {
      files.set(path, contents)
      await Promise.resolve()
    },
    remove: async (path) => {
      files.delete(path)
      removed.push(path)
      await Promise.resolve()
    }
  }
}

describe("homeNetworkKeyfile", () => {
  it("writes a saved WPA-PSK profile with the SSID as a byte list", () => {
    const keyfile = homeNetworkKeyfile({ ssid: "home;1", passphrase: PASSPHRASE })
    expect(keyfile).toContain("id=qualithm-home\n")
    expect(keyfile).toContain("interface-name=wlan0\n")
    expect(keyfile).toContain("autoconnect=true\n")
    expect(keyfile).toContain("ssid=104;111;109;101;59;49;\n")
    expect(keyfile).toContain("key-mgmt=wpa-psk\n")
    expect(keyfile).toContain(`psk=${PASSPHRASE}\n`)
  })

  it("encodes a UTF-8 SSID byte by byte", () => {
    expect(homeNetworkKeyfile({ ssid: "café", passphrase: "" })).toContain(
      "ssid=99;97;102;195;169;\n"
    )
  })

  it("writes an open network without a security section", () => {
    const keyfile = homeNetworkKeyfile({ ssid: "guest", passphrase: "" }, "wlan1")
    expect(keyfile).not.toContain("[wifi-security]")
    expect(keyfile).toContain("interface-name=wlan1\n")
  })

  it("escapes backslashes and edge spaces in the passphrase", () => {
    const keyfile = homeNetworkKeyfile({ ssid: "home", passphrase: " a\\b c d " })
    expect(keyfile).toContain("psk=\\sa\\\\b c d\\s\n")
  })

  it("accepts a 64-digit hex key", () => {
    const hex = "a".repeat(64)
    expect(homeNetworkKeyfile({ ssid: "home", passphrase: hex })).toContain(`psk=${hex}\n`)
  })

  it("refuses an SSID or passphrase Wi-Fi can't use", () => {
    for (const network of [
      { ssid: "", passphrase: PASSPHRASE },
      { ssid: "x".repeat(33), passphrase: PASSPHRASE },
      { ssid: "home", passphrase: "short" },
      { ssid: "home", passphrase: "x".repeat(64) },
      { ssid: "home", passphrase: "line\nbreak!" }
    ]) {
      expect(() => homeNetworkKeyfile(network)).toThrow(ProvisioningError)
    }
  })
})

describe("createNmcliHomeNetwork", () => {
  it("writes the keyfile, then loads and brings up the profile, never passing the passphrase", async () => {
    const ran: string[][] = []
    const store = fakeStore()
    const home = createNmcliHomeNetwork(
      { connectionsDir: "/run/nm" },
      async (args) => {
        ran.push([...args])
        await Promise.resolve()
      },
      store
    )

    await home.join({ ssid: "home", passphrase: PASSPHRASE })

    expect(store.files.get("/run/nm/qualithm-home.nmconnection")).toContain(`psk=${PASSPHRASE}`)
    expect(ran).toEqual([
      ["connection", "load", "/run/nm/qualithm-home.nmconnection"],
      ["connection", "up", "qualithm-home"]
    ])
    for (const args of ran) {
      expect(args.join(" ")).not.toContain(PASSPHRASE)
    }
  })

  it("rejects when the network can't be joined", async () => {
    const home = createNmcliHomeNetwork(
      {},
      async (args) => {
        await Promise.resolve()
        if (args[1] === "up") {
          throw new Error("Secrets were required, but not provided")
        }
      },
      fakeStore()
    )
    await expect(home.join({ ssid: "home", passphrase: PASSPHRASE })).rejects.toThrow("Secrets")
  })

  it("forget deletes the profile and removes the keyfile, even when the profile never loaded", async () => {
    const store = fakeStore()
    const home = createNmcliHomeNetwork(
      { connectionsDir: "/run/nm" },
      async () => {
        await Promise.resolve()
        throw new Error("Unknown connection 'qualithm-home'")
      },
      store
    )

    await expect(home.forget()).resolves.toBeUndefined()
    expect(store.removed).toEqual(["/run/nm/qualithm-home.nmconnection"])
  })

  it("defaults to the real nmcli runner and filesystem when none are injected", () => {
    const home = createNmcliHomeNetwork()
    expect(typeof home.join).toBe("function")
    expect(typeof home.forget).toBe("function")
  })
})
