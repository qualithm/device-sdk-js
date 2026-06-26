/**
 * Claim-code exchange against the Qualithm provisioning endpoint.
 *
 * A device presents its single-use claim code to `POST /provision/claim`; the
 * platform mints a per-device token credential and returns the device identity.
 * The result is shaped into a {@link DeviceCredential} ready for persistence.
 */

import { ClaimError } from "./errors.js"
import type { CredentialKind, DeviceCredential } from "./types.js"

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

  return {
    deviceId: data.deviceId,
    teamId: data.teamId,
    spaceId: data.spaceId,
    kind: data.credential?.kind ?? "token",
    token: data.secret,
    issuedAt: new Date().toISOString(),
    ...(typeof data.credential?.expiresAt === "string" && { expiresAt: data.credential.expiresAt })
  }
}
