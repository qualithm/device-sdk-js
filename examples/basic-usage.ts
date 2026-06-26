/**
 * Basic usage example.
 *
 * Configures a Device, generates a key + CSR (offline-safe), and—only when
 * `QUALITHM_CLAIM_CODE` is set—claims and connects to a gateway.
 *
 * @example
 * ```bash
 * bun run examples/basic-usage.ts
 * ```
 */

/* eslint-disable no-console */

import { Device, generateDeviceCsr } from "@qualithm/device"

async function main(): Promise<void> {
  console.log("=== Basic Usage ===\n")

  const claimCode = process.env.QUALITHM_CLAIM_CODE
  const host = process.env.QUALITHM_GATEWAY ?? "gw.example.qualithm.com"

  const device = new Device({
    provisioningUrl: process.env.QUALITHM_API ?? "https://api.qualithm.com",
    broker: { host },
    ...(claimCode !== undefined && { claimCode })
  })

  device.onState((state) => {
    console.log(`  state: ${state}`)
  })

  // CSR generation is offline-safe — demonstrate it regardless.
  console.log("--- Generate a device key + CSR (certificate path) ---")
  const { privateKeyPem, csrPem } = await generateDeviceCsr("11111111-1111-1111-1111-111111111111")
  console.log(`  private key: ${privateKeyPem.split("\n")[0] ?? ""}`)
  console.log(`  csr:         ${csrPem.split("\n")[0] ?? ""}`)

  if (claimCode === undefined) {
    console.log("\nSet QUALITHM_CLAIM_CODE (and QUALITHM_GATEWAY) to claim and connect.")
    return
  }

  console.log("\n--- Claim once, then connect over MQTT-TLS ---")
  await device.connect()
  await device.publish("telemetry/temperature", JSON.stringify({ c: 21.4 }))
  console.log("  published telemetry")
  await device.disconnect()
  console.log("\nDone.")
}

await main()
