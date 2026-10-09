/**
 * A reference {@link HomeNetworkController} for the Pi/Node path
 * (qualithm/pm#1545): joins the home network the companion app sent with the
 * claim, through NetworkManager.
 *
 * The passphrase never appears in a command line, where `ps` and process
 * audit logs would show it. It goes into a NetworkManager keyfile written with
 * mode 0600, which `nmcli connection load` then reads. The profile is saved,
 * so the device reconnects after a reboot.
 */

import { execFile } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import type { NmcliRunner } from "./access-point.js"
import { ProvisioningError } from "./errors.js"
import type { HomeNetwork, HomeNetworkController } from "./provision-server.js"

const execFileAsync = promisify(execFile)

/** The connection profile name the home network is saved under. */
const HOME_CONNECTION = "qualithm-home"

/** NetworkManager's directory for saved connection keyfiles. */
const DEFAULT_CONNECTIONS_DIR = "/etc/NetworkManager/system-connections"

/** Options for {@link createNmcliHomeNetwork}. */
export type NmcliHomeNetworkOptions = {
  /** Wi-Fi interface to join on. Defaults to `wlan0`. */
  ifname?: string
  /** Where keyfiles are written. Defaults to NetworkManager's system connections directory. */
  connectionsDir?: string
}

/** Writes and removes the keyfile. The default uses the filesystem; injectable in tests. */
export type KeyfileStore = {
  /** Write `contents` to `path`, readable by its owner only. */
  write: (path: string, contents: string) => Promise<void>
  /** Remove `path`; a missing file is not an error. */
  remove: (path: string) => Promise<void>
}

const PSK_PRINTABLE = /^[\x20-\x7e]{8,63}$/
const PSK_HEX = /^[0-9a-fA-F]{64}$/

/** Escape a value for a GKeyFile line, as NetworkManager's keyfile reader expects. */
const escapeValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/^ /, "\\s").replace(/ $/, "\\s")

/**
 * Build the NetworkManager keyfile for a home network. Pure, so the exact
 * contents are what the tests assert.
 *
 * The SSID is written as a byte list, which needs no escaping and carries any
 * UTF-8 name. An empty passphrase makes an open network.
 *
 * @param network - the SSID and passphrase from the claim
 * @param ifname - the Wi-Fi interface
 * @returns the keyfile contents
 * @throws {@link ProvisioningError} when the SSID is empty or longer than 32
 * bytes, or the passphrase isn't 8–63 printable characters or 64 hex digits
 */
export const homeNetworkKeyfile = (network: HomeNetwork, ifname = "wlan0"): string => {
  const ssid = new TextEncoder().encode(network.ssid)
  if (ssid.length === 0 || ssid.length > 32) {
    throw new ProvisioningError("The home network name must be 1 to 32 bytes")
  }
  const open = network.passphrase === ""
  if (!open && !PSK_PRINTABLE.test(network.passphrase) && !PSK_HEX.test(network.passphrase)) {
    throw new ProvisioningError(
      "The home network passphrase must be 8 to 63 characters, or 64 hex digits"
    )
  }

  const lines = [
    "[connection]",
    `id=${HOME_CONNECTION}`,
    "type=wifi",
    `interface-name=${ifname}`,
    "autoconnect=true",
    "",
    "[wifi]",
    "mode=infrastructure",
    `ssid=${Array.from(ssid).join(";")};`,
    ""
  ]
  if (!open) {
    lines.push("[wifi-security]", "key-mgmt=wpa-psk", `psk=${escapeValue(network.passphrase)}`, "")
  }
  lines.push("[ipv4]", "method=auto", "", "[ipv6]", "method=auto", "")
  return lines.join("\n")
}

/* istanbul ignore next -- the boundary that actually runs nmcli; exercised on the device, covered only via the injected runner in tests */
const defaultRunner: NmcliRunner = async (args) => {
  await execFileAsync("nmcli", [...args])
}

/* istanbul ignore next -- the filesystem boundary; covered only via the injected store in tests */
const defaultStore: KeyfileStore = {
  write: async (path, contents) => {
    await writeFile(path, contents, { mode: 0o600 })
  },
  remove: async (path) => {
    await rm(path, { force: true })
  }
}

/**
 * Create a {@link HomeNetworkController} that joins through NetworkManager.
 * Supply it as `homeNetwork` to `ProvisioningServer`/`Device.startProvisioning`
 * on a Pi-class device. Writing the keyfile needs root, as NetworkManager's
 * system connections directory does.
 *
 * `forget` deletes the profile and the keyfile, best-effort, so a failed
 * onboarding never leaves the passphrase on disk.
 *
 * @param options - interface and keyfile directory
 * @param runner - runs one `nmcli` invocation
 * @param store - writes and removes the keyfile
 * @returns the controller
 */
export const createNmcliHomeNetwork = (
  options: NmcliHomeNetworkOptions = {},
  runner: NmcliRunner = defaultRunner,
  store: KeyfileStore = defaultStore
): HomeNetworkController => {
  const ifname = options.ifname ?? "wlan0"
  const path = join(
    options.connectionsDir ?? DEFAULT_CONNECTIONS_DIR,
    `${HOME_CONNECTION}.nmconnection`
  )
  return {
    join: async (network) => {
      await store.write(path, homeNetworkKeyfile(network, ifname))
      await runner(["connection", "load", path])
      await runner(["connection", "up", HOME_CONNECTION])
    },
    forget: async () => {
      try {
        await runner(["connection", "delete", HOME_CONNECTION])
      } catch {
        // The profile may never have loaded; the keyfile is removed below.
      }
      await store.remove(path)
    }
  }
}
