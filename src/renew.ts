/**
 * Development-credential renewal: a credential is replaced well before it
 * expires, through `POST /v1/provision/credentials/renew`, so a device never
 * has to be claimed again while it keeps running.
 */

import "reflect-metadata"

import * as x509 from "@peculiar/x509"

import { parseBroker } from "./claim.js"
import { generateDeviceCsr } from "./csr.js"
import { CredentialError, RenewalError } from "./errors.js"
import type { DeviceCredential } from "./types.js"
import { trimTrailingSlash } from "./url.js"

x509.cryptoProvider.set(crypto)

/** The share of a credential's lifetime that passes before it is renewed. */
export const RENEW_AFTER_FRACTION = 2 / 3

const PROOF_PREFIX = "qualithm-renew-v1"
const EC_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" }
const EC_SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" }

/** When a credential becomes valid and when it expires. */
export type CredentialLifetime = { start: number; end: number }

/**
 * The lifetime of a credential: the certificate's validity for a certificate,
 * issue to expiry for a token.
 *
 * @returns `undefined` for a credential that never expires, or a certificate
 *   that can't be read
 */
export const credentialLifetime = (
  credential: DeviceCredential
): CredentialLifetime | undefined => {
  if (credential.kind === "cert" && credential.certificatePem !== undefined) {
    try {
      const certificate = new x509.X509Certificate(credential.certificatePem)
      return { start: certificate.notBefore.getTime(), end: certificate.notAfter.getTime() }
    } catch {
      // An unreadable certificate has no lifetime to act on; the gateway judges it.
      return undefined
    }
  }
  if (credential.expiresAt === undefined) {
    return undefined
  }
  return { start: Date.parse(credential.issuedAt), end: Date.parse(credential.expiresAt) }
}

/**
 * When to renew a credential: once {@link RENEW_AFTER_FRACTION} of its
 * lifetime has passed.
 *
 * @returns epoch milliseconds, or `undefined` for a credential that never expires
 */
export const renewalTime = (credential: DeviceCredential): number | undefined => {
  const lifetime = credentialLifetime(credential)
  if (lifetime === undefined) {
    return undefined
  }
  return lifetime.start + (lifetime.end - lifetime.start) * RENEW_AFTER_FRACTION
}

/**
 * Refuse a credential that has already expired, with what to do about it.
 *
 * @throws {@link CredentialError} when the credential's expiry has passed
 */
export const assertNotExpired = (credential: DeviceCredential, now: number = Date.now()): void => {
  const lifetime = credentialLifetime(credential)
  if (lifetime !== undefined && lifetime.end <= now) {
    throw new CredentialError(
      `the stored credential expired at ${new Date(lifetime.end).toISOString()}: claim the device again with a new claim code`
    )
  }
}

type RenewEnvelope = {
  message?: string
  data?: {
    secret?: string
    broker?: unknown
    credential?: { expiresAt?: string | null }
    certificatePem?: string
    caCertificatePem?: string
  }
}

const safeJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

const toBase64 = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("base64")

/** Sign the renewal proof with the certificate credential's current key: raw `r || s`, base64. */
const signProof = async (privateKeyPem: string, message: string): Promise<string> => {
  const der = x509.PemConverter.decodeFirst(privateKeyPem)
  const key = await crypto.subtle.importKey("pkcs8", der, EC_KEY_ALGORITHM, false, ["sign"])
  const signature = await crypto.subtle.sign(
    EC_SIGN_ALGORITHM,
    key,
    new TextEncoder().encode(message)
  )
  return toBase64(signature)
}

const post = async (
  url: string,
  init: { headers: Record<string, string>; body?: string }
): Promise<RenewEnvelope["data"] & object> => {
  let response: Response
  try {
    response = await fetch(url, { method: "POST", ...init })
  } catch (error) {
    throw new RenewalError(
      "could not reach the provisioning endpoint to renew the credential: check the network connection",
      { cause: error }
    )
  }
  const envelope = (await safeJson(response)) as RenewEnvelope | null
  const data = envelope?.data
  if (!response.ok || data === undefined) {
    const message = envelope?.message ?? `renewal failed with status ${String(response.status)}`
    throw new RenewalError(message, { status: response.status })
  }
  return data
}

/**
 * Exchange a credential for a fresh one with the same lifetime. The old
 * credential stays valid until it expires, so a renewal that is interrupted
 * leaves the device working.
 *
 * @param provisioningUrl - Base URL of the provisioning API
 * @param credential - The credential in use
 * @param now - The current time, for the certificate proof
 * @throws {@link RenewalError} when the platform can't be reached or refuses
 */
export const renewCredential = async (
  provisioningUrl: string,
  credential: DeviceCredential,
  now: () => number = Date.now
): Promise<DeviceCredential> => {
  const url = `${trimTrailingSlash(provisioningUrl)}/v1/provision/credentials/renew`
  const issuedAt = new Date(now()).toISOString()

  if (credential.kind === "cert") {
    if (credential.privateKeyPem === undefined || credential.certificatePem === undefined) {
      throw new RenewalError(
        "stored certificate credential is missing its private key or certificate"
      )
    }
    const next = await generateDeviceCsr(credential.deviceId)
    const signedAt = issuedAt
    const signature = await signProof(
      credential.privateKeyPem,
      `${PROOF_PREFIX}\n${signedAt}\n${next.csrPem}`
    )
    const data = await post(url, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        certificatePem: credential.certificatePem,
        csrPem: next.csrPem,
        signedAt,
        signature
      })
    })
    if (data.certificatePem === undefined) {
      throw new RenewalError("the renewal response carries no certificate")
    }
    const broker = parseBroker(data.broker) ?? credential.broker
    const { expiresAt: _previousExpiry, ...current } = credential
    const certExpiresAt = data.credential?.expiresAt
    return {
      ...current,
      privateKeyPem: next.privateKeyPem,
      certificatePem: data.certificatePem,
      ...(data.caCertificatePem !== undefined && { caCertificatePem: data.caCertificatePem }),
      issuedAt,
      ...(typeof certExpiresAt === "string" && { expiresAt: certExpiresAt }),
      ...(broker !== undefined && { broker })
    }
  }

  if (credential.token === undefined || credential.token === "") {
    throw new RenewalError("stored token credential is missing its secret")
  }
  const data = await post(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${credential.deviceId}:${credential.token}`)}`
    }
  })
  if (data.secret === undefined) {
    throw new RenewalError("the renewal response carries no secret")
  }
  const { expiresAt: _previous, ...rest } = credential
  const expiresAt = data.credential?.expiresAt
  return {
    ...rest,
    token: data.secret,
    issuedAt,
    ...(typeof expiresAt === "string" && { expiresAt })
  }
}
