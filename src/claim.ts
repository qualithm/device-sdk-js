/**
 * Claim-code exchange against the Qualithm provisioning endpoint.
 *
 * A device presents its single-use claim code to `POST /provision/claim`; the
 * platform mints a per-device token credential and returns the device identity.
 * The result is shaped into a {@link DeviceCredential} ready for persistence.
 */

import { ClaimError } from "./errors.js"
import type { BrokerEndpoint, CredentialKind, DeviceCredential } from "./types.js"

/** Body sent to the provisioning endpoint. */
export type ClaimRequest = {
  /** The single-use claim code (e.g. `qmc_<selector>.<verifier>`). */
  code: string
  /** Optional human-friendly device name. */
  name?: string
}

type ClaimData = {
  deviceId: string
  spaceId: string
  teamId: string
  secret: string
  broker?: unknown
  credential?: {
    kind?: CredentialKind
    expiresAt?: string | null
  }
}

type ClaimEnvelope = {
  success?: boolean
  message?: string
  data?: ClaimData
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

/**
 * Read the `broker` a provisioning response carries. An older platform omits it, and a malformed
 * value is ignored rather than trusted, so either leaves the device on its configured broker.
 *
 * @param value - The response's `data.broker`
 * @returns The broker, or `undefined` when absent or malformed
 */
export const parseBroker = (value: unknown): BrokerEndpoint | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  const { host, port } = value as { host?: unknown; port?: unknown }
  if (typeof host !== "string" || host === "" || typeof port !== "number") {
    return undefined
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  return { host, port }
}

const safeJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Exchange a claim code for a persistable device credential.
 *
 * @param provisioningUrl - Base URL of the provisioning API.
 * @param request - The claim code and optional device name.
 * @throws {@link ClaimError} when the endpoint is unreachable or rejects the code.
 */
export const claimDevice = async (
  provisioningUrl: string,
  request: ClaimRequest
): Promise<DeviceCredential> => {
  const url = `${trimTrailingSlash(provisioningUrl)}/provision/claim`

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    })
  } catch (error) {
    throw new ClaimError("Failed to reach the provisioning endpoint", { cause: error })
  }

  const envelope = (await safeJson(response)) as ClaimEnvelope | null
  const data = envelope?.data
  if (!response.ok || data === undefined) {
    const message = envelope?.message ?? `Claim failed with status ${String(response.status)}`
    throw new ClaimError(message, { status: response.status })
  }

  const broker = parseBroker(data.broker)
  return {
    deviceId: data.deviceId,
    teamId: data.teamId,
    spaceId: data.spaceId,
    kind: data.credential?.kind ?? "token",
    token: data.secret,
    issuedAt: new Date().toISOString(),
    ...(typeof data.credential?.expiresAt === "string" && { expiresAt: data.credential.expiresAt }),
    ...(broker !== undefined && { broker })
  }
}
