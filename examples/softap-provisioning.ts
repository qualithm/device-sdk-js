/**
 * Soft-AP provisioning example.
 *
 * Starts the device-side provisioning server and serves the claim exchange
 * until a claim succeeds. POST a claim code with curl to stand in for the
 * companion app.
 *
 * @example
 * ```bash
 * bun run examples/softap-provisioning.ts
 * curl -X POST http://127.0.0.1:8080/provision/claim \
 *   -H 'content-type: application/json' \
 *   -d '{"code":"qmc_..."}'
 * ```
 */

/* eslint-disable no-console */

import { Device } from "@qualithm/device"

async function main(): Promise<void> {
  console.log("=== Soft-AP Provisioning ===\n")

  const device = new Device({
    provisioningUrl: process.env.QUALITHM_API ?? "https://api.qualithm.com",
    broker: { host: process.env.QUALITHM_GATEWAY ?? "gw.example.qualithm.com" }
  })

  device.onState((state) => {
    console.log(`  state: ${state}`)
  })

  // On real hardware an accessPoint controller brings up the setup network
  // here; on a laptop the server alone is enough to walk the exchange.
  const server = await device.startProvisioning({
    host: "127.0.0.1",
    port: 8080,
    onProvisioned: async () => {
      console.log("  claimed — connecting to the gateway")
      await device.connect()
      await device.disconnect()
    }
  })

  const address = server.boundAddress
  if (address !== null) {
    console.log(`  serving the claim exchange on http://${address.host}:${String(address.port)}`)
  }
  console.log('  POST {"code":"qmc_..."} to /provision/claim to claim this device')
}

main().catch(console.error)
