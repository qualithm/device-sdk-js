/**
 * Error handling example.
 *
 * Demonstrates the SDK's typed error hierarchy and `isError()` narrowing.
 *
 * @example
 * ```bash
 * bun run examples/error-handling.ts
 * ```
 */

/* eslint-disable no-console */

import {
  claimDevice,
  ClaimError,
  createMemoryCredentialStore,
  CredentialError,
  Device
} from "@qualithm/device"

async function main(): Promise<void> {
  console.log("=== Error Handling ===\n")

  // 1. Connecting with no stored credential and no claim code → CredentialError.
  console.log("--- Missing credential ---")
  const device = new Device({
    provisioningUrl: "https://api.qualithm.com",
    broker: { host: "gw.example.qualithm.com" },
    store: createMemoryCredentialStore()
  })
  try {
    await device.connect()
  } catch (error) {
    if (CredentialError.isError(error)) {
      console.log(`  CredentialError: ${error.message}`)
    } else {
      throw error
    }
  }

  // 2. Claiming against an unreachable endpoint → ClaimError.
  console.log("\n--- Unreachable provisioning endpoint ---")
  try {
    await claimDevice("https://invalid.invalid", { code: "qmc_bad" })
  } catch (error) {
    if (ClaimError.isError(error)) {
      console.log(`  ClaimError: ${error.message}`)
    } else {
      throw error
    }
  }

  console.log("\nDone.")
}

await main()
