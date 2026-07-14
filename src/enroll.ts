/**
 * Certificate enrollment: upgrade a token-authenticated device to an mTLS
 * `cert` credential by generating a CSR and submitting it to the device-facing
 * provisioning endpoint (`POST /provision/credentials/cert`).
 *
 * The device authenticates the same way it does for MQTT — its id as the
 * username, its existing token as the password — but presented as HTTP Basic
 * auth rather than a CONNECT packet's username/password fields.
 */

import { generateDeviceCsr } from "./csr.js"
import { EnrollError } from "./errors.js"
import type { DeviceCredential } from "./types.js"

/** Optional certificate parameters for {@link enrollDeviceCertificate}. */
export type EnrollRequest = {
  /** Human-friendly label for the issued credential. */
  label?: string
  /** Certificate lifetime in days, bounded by the platform's configured max. */
  expiresInDays?: number
}

type EnrollData = {
  certificatePem: string
  caCertificatePem: string
}

type EnrollEnvelope = {
  success?: boolean
  message?: string
  data?: EnrollData
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
 * Generate a key/CSR and submit it to obtain an mTLS certificate credential,
 * returning a new {@link DeviceCredential} with `kind: "cert"` ready for
 * persistence and connecting.
 *
 * @param provisioningUrl - Base URL of the provisioning API.
 * @param credential - The device's existing token credential, used to
 *   authenticate the enrollment request.
 * @param request - Optional certificate label/lifetime.
 * @throws {@link EnrollError} when `credential` has no token, or the endpoint
 *   is unreachable or rejects the CSR.
 */
export const enrollDeviceCertificate = async (
  provisioningUrl: string,
  credential: DeviceCredential,
  request?: EnrollRequest
): Promise<DeviceCredential> => {
  if (credential.token === undefined || credential.token === "") {
    throw new EnrollError("A token credential is required to enroll for a certificate")
  }

  const keyMaterial = await generateDeviceCsr(credential.deviceId)
  const url = `${trimTrailingSlash(provisioningUrl)}/provision/credentials/cert`
  const authorization = `Basic ${btoa(`${credential.deviceId}:${credential.token}`)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ csrPem: keyMaterial.csrPem, ...request })
    })
  } catch (error) {
    throw new EnrollError("Failed to reach the provisioning endpoint", { cause: error })
  }

  const envelope = (await safeJson(response)) as EnrollEnvelope | null
  const data = envelope?.data
  if (!response.ok || data === undefined) {
    const message = envelope?.message ?? `Enrollment failed with status ${String(response.status)}`
    throw new EnrollError(message, { status: response.status })
  }

  return {
    deviceId: credential.deviceId,
    teamId: credential.teamId,
    spaceId: credential.spaceId,
    kind: "cert",
    privateKeyPem: keyMaterial.privateKeyPem,
    certificatePem: data.certificatePem,
    caCertificatePem: data.caCertificatePem,
    issuedAt: new Date().toISOString()
  }
}
