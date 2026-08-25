/**
 * A reference {@link AccessPointController} for the Pi/Node path
 * (platform#169): brings up the device's `qualithm-setup-*` network as a
 * NetworkManager hotspot on a credential-less device and tears it down once
 * the claim lands. Raspberry Pi OS and most Linux distros manage Wi-Fi with
 * NetworkManager, so `nmcli` is the mechanism; the commands are constructed
 * pure and executed only at the boundary, so the shape is unit-testable
 * without a host radio.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { AccessPointController } from "./provision-server.js"

const execFileAsync = promisify(execFile)

/** The connection profile name the hotspot is created under. */
const HOTSPOT_CONNECTION = "qualithm-setup"

/** Options for {@link createNmcliAccessPoint}. */
export type NmcliAccessPointOptions = {
  /** The setup network's SSID. Must start with `qualithm-setup-`. */
  ssid: string
  /** Wi-Fi interface to host the hotspot on. Defaults to `wlan0`. */
  ifname?: string
}

/** The two command lines a hotspot lifecycle runs, in order. */
export type HotspotCommands = {
  /** Bring the hotspot up. */
  readonly up: readonly string[]
  /** Tear the hotspot down. */
  readonly down: readonly string[]
}

/**
 * Build the `nmcli` invocations for the hotspot lifecycle. Pure — separated
 * from execution so the exact command shape is what the tests assert.
 *
 * `nmcli device wifi hotspot ifname <iface> ssid <ssid>` creates and activates
 * an open hotspot (no password → an open network, which is what the setup
 * flow wants: the claim code is the secret, not the Wi-Fi). The down command
 * removes the connection profile so a re-provision starts clean.
 */
export const hotspotCommands = (options: NmcliAccessPointOptions): HotspotCommands => {
  const ifname = options.ifname ?? "wlan0"
  return {
    up: ["device", "wifi", "hotspot", "ifname", ifname, "ssid", options.ssid],
    down: ["connection", "delete", HOTSPOT_CONNECTION]
  }
}

/** Runs one `nmcli` invocation. The default shells out; injectable in tests. */
export type NmcliRunner = (args: readonly string[]) => Promise<void>

const defaultRunner: NmcliRunner = async (args) => {
  await execFileAsync("nmcli", [...args])
}

/**
 * Create an {@link AccessPointController} that drives a NetworkManager
 * hotspot via `nmcli`. Supply it as `accessPoint` to
 * `ProvisioningServer`/`Device.startProvisioning` on a Pi-class device.
 *
 * `stop` is idempotent: a device that was never asked to host (or whose
 * profile is already gone) tears down cleanly, which keeps a failed or
 * interrupted onboarding restartable.
 */
export const createNmcliAccessPoint = (
  options: NmcliAccessPointOptions,
  runner: NmcliRunner = defaultRunner
): AccessPointController => {
  const { up, down } = hotspotCommands(options)
  return {
    start: async () => {
      await runner(up)
    },
    stop: async () => {
      try {
        await runner(down)
      } catch {
        // The hotspot profile may not exist (never started, or already
        // removed) — teardown is best-effort so onboarding can restart.
      }
    }
  }
}
