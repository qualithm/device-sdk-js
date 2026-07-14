/**
 * Core command implementations for the `qualithm-device` CLI.
 *
 * Decoupled from argv parsing and process I/O (stdout/exit codes) so each
 * command's logic can be unit-tested with mocked dependencies — see
 * `src/__tests__/unit/cli/commands.test.ts`.
 */

import { claimDevice } from "../claim.js"
import type { Device } from "../device.js"
import { enrollDeviceCertificate } from "../enroll.js"
import { CredentialError } from "../errors.js"
import type { CredentialStore, DeviceCredential } from "../types.js"

export type ClaimCommandOptions = {
  code: string
  provisioningUrl: string
  store: CredentialStore
  name?: string
}

/** Exchange a claim code for a credential and persist it. */
export async function claimCommand(options: ClaimCommandOptions): Promise<DeviceCredential> {
  const credential = await claimDevice(options.provisioningUrl, {
    code: options.code,
    ...(options.name !== undefined && { name: options.name })
  })
  await options.store.save(credential)
  return credential
}

export type ProvisionCommandOptions = {
  provisioningUrl: string
  store: CredentialStore
  label?: string
  expiresInDays?: number
}

/**
 * Upgrade the stored token credential to an mTLS certificate credential.
 *
 * @throws {@link CredentialError} when no credential is stored yet.
 */
export async function provisionCommand(
  options: ProvisionCommandOptions
): Promise<DeviceCredential> {
  const existing = await options.store.load()
  if (existing === null) {
    throw new CredentialError("No stored credential — run `claim` first")
  }

  const credential = await enrollDeviceCertificate(options.provisioningUrl, existing, {
    ...(options.label !== undefined && { label: options.label }),
    ...(options.expiresInDays !== undefined && { expiresInDays: options.expiresInDays })
  })
  await options.store.save(credential)
  return credential
}

/** A single publish action performed as part of a `connect` smoke test. */
export type PublishAction = {
  topic: string
  payload: string
}

export type ConnectCommandOptions = {
  device: Device
  subscribeTopics?: string[]
  publish?: PublishAction
  onMessage?: (topic: string, payload: Uint8Array) => void
}

export type ConnectResult = {
  identity: DeviceCredential
  subscribed: string[]
  published: PublishAction | null
}

/**
 * Open the MQTT-over-TLS session and optionally run a subscribe/publish smoke
 * test. Does not disconnect — the caller decides whether to hold the process
 * open or tear the connection down.
 */
export async function connectCommand(options: ConnectCommandOptions): Promise<ConnectResult> {
  await options.device.connect()

  const subscribeTopics = options.subscribeTopics ?? []
  if (subscribeTopics.length > 0) {
    if (options.onMessage !== undefined) {
      options.device.onMessage(options.onMessage)
    }
    await options.device.subscribe(subscribeTopics)
  }

  if (options.publish !== undefined) {
    await options.device.publish(options.publish.topic, options.publish.payload)
  }

  const { identity } = options.device
  if (identity === null) {
    throw new CredentialError("Device connected but has no identity")
  }

  return { identity, subscribed: subscribeTopics, published: options.publish ?? null }
}
