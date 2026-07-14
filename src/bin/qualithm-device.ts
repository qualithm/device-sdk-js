#!/usr/bin/env node
/**
 * `qualithm-device` — device-side CLI wrapping `@qualithm/device`:
 * `claim | provision | connect`.
 *
 * Reused across `claim`/`provision`/`connect` is the on-disk credential store
 * (`--store`, defaults to `.qualithm/credential.json`, same as {@link Device}'s
 * default) and the provisioning URL (`--provisioning-url` or
 * `QUALITHM_PROVISIONING_URL`). No new wire logic — every command is a thin
 * wrapper over the SDK's `claimDevice`/`enrollDeviceCertificate`/`Device`.
 */

import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { claimCommand, connectCommand, provisionCommand } from "../cli/commands.js"
import { printError, printResult } from "../cli/output.js"
import { Device } from "../device.js"
import { QualithmDeviceError } from "../errors.js"
import { createFileCredentialStore } from "../store.js"

const DEFAULT_STORE_PATH = ".qualithm/credential.json"
const DEFAULT_BROKER_PORT = 8883

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new QualithmDeviceError(`${flag} is required (flag or matching env var)`)
  }
  return value
}

async function readCa(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) {
    return undefined
  }
  return readFile(path, "utf8")
}

async function runClaim(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      name: { type: "string" },
      "provisioning-url": { type: "string" },
      store: { type: "string" }
    }
  })
  const json = values.json === true

  const code = requireValue(positionals[0], "<code>")
  const provisioningUrl = requireValue(
    values["provisioning-url"] ?? process.env.QUALITHM_PROVISIONING_URL,
    "--provisioning-url"
  )
  const store = createFileCredentialStore(values.store ?? DEFAULT_STORE_PATH)

  const credential = await claimCommand({
    code,
    provisioningUrl,
    store,
    ...(values.name !== undefined && { name: values.name })
  })

  printResult(json, `Claimed device ${credential.deviceId} (kind: ${credential.kind})`, credential)
}

async function runProvision(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "expires-in-days": { type: "string" },
      json: { type: "boolean" },
      label: { type: "string" },
      "provisioning-url": { type: "string" },
      store: { type: "string" }
    }
  })
  const json = values.json === true

  const provisioningUrl = requireValue(
    values["provisioning-url"] ?? process.env.QUALITHM_PROVISIONING_URL,
    "--provisioning-url"
  )
  const store = createFileCredentialStore(values.store ?? DEFAULT_STORE_PATH)

  const expiresInDays =
    values["expires-in-days"] !== undefined ? Number(values["expires-in-days"]) : undefined

  const credential = await provisionCommand({
    provisioningUrl,
    store,
    ...(values.label !== undefined && { label: values.label }),
    ...(expiresInDays !== undefined && { expiresInDays })
  })

  printResult(json, `Enrolled certificate credential for ${credential.deviceId}`, credential)
}

/** Resolve once `SIGINT` is received, so `connect` can hold the process open. */
async function waitForSigint(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      resolve()
    })
  })
}

async function runConnect(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ca: { type: "string" },
      host: { type: "string" },
      insecure: { type: "boolean" },
      json: { type: "boolean" },
      payload: { type: "string" },
      port: { type: "string" },
      "provisioning-url": { type: "string" },
      publish: { type: "string" },
      store: { type: "string" },
      subscribe: { type: "string", multiple: true }
    }
  })
  const json = values.json === true

  const provisioningUrl = requireValue(
    values["provisioning-url"] ?? process.env.QUALITHM_PROVISIONING_URL,
    "--provisioning-url"
  )
  const host = requireValue(values.host ?? process.env.QUALITHM_BROKER_HOST, "--host")
  const store = createFileCredentialStore(values.store ?? DEFAULT_STORE_PATH)
  const ca = await readCa(values.ca)

  const device = new Device({
    provisioningUrl,
    broker: {
      host,
      port: values.port !== undefined ? Number(values.port) : DEFAULT_BROKER_PORT,
      ...(ca !== undefined && { ca }),
      ...(values.insecure === true && { rejectUnauthorized: false })
    },
    store
  })

  const publish =
    values.publish !== undefined
      ? { topic: values.publish, payload: values.payload ?? "" }
      : undefined

  const messages: { topic: string; payload: string }[] = []
  const result = await connectCommand({
    device,
    ...(values.subscribe !== undefined && { subscribeTopics: values.subscribe }),
    ...(publish !== undefined && { publish }),
    onMessage: (topic, payload) => {
      const decoded = new TextDecoder().decode(payload)
      messages.push({ topic, payload: decoded })
      if (!json) {
        console.log(`< ${topic}: ${decoded}`)
      }
    }
  })

  printResult(
    json,
    `Connected as ${result.identity.deviceId}${
      result.published !== null ? ` (published to ${result.published.topic})` : ""
    }`,
    { ...result, messages }
  )

  // A one-shot publish smoke test exits immediately; otherwise hold the
  // process open (e.g. to receive subscribed messages) until interrupted.
  if (result.published === null) {
    await waitForSigint()
  }
  await device.disconnect()
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv.at(0)
  const rest = argv.slice(1)

  if (command === "claim") {
    await runClaim(rest)
    return
  }
  if (command === "provision") {
    await runProvision(rest)
    return
  }
  if (command === "connect") {
    await runConnect(rest)
    return
  }
  throw new QualithmDeviceError(
    `Unknown command "${command ?? ""}" — expected claim, provision, or connect`
  )
}

main().catch((error: unknown) => {
  const json = process.argv.includes("--json")
  printError(json, error)
  process.exitCode = 1
})
