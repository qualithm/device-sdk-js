import "reflect-metadata"

import * as x509 from "@peculiar/x509"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CredentialError, RenewalError } from "../../errors.js"
import { assertNotExpired, credentialLifetime, renewalTime, renewCredential } from "../../renew.js"
import type { DeviceCredential } from "../../types.js"

x509.cryptoProvider.set(crypto)

const EC = { name: "ECDSA", namedCurve: "P-256" }
const SIGN = { name: "ECDSA", hash: "SHA-256" }

const token: DeviceCredential = {
  deviceId: "dev_1",
  teamId: "t",
  scopeId: "s",
  kind: "token",
  token: "qmd_old",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-31T00:00:00.000Z"
}

/** A certificate credential valid over `[notBefore, notAfter)`, with its key pair. */
const certCredential = async (
  notBefore: Date,
  notAfter: Date
): Promise<{ credential: DeviceCredential; keys: CryptoKeyPair }> => {
  const keys = await crypto.subtle.generateKey(EC, true, ["sign", "verify"])
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=dev_1",
    notBefore,
    notAfter,
    keys,
    signingAlgorithm: SIGN
  })
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey)
  return {
    keys,
    credential: {
      deviceId: "dev_1",
      teamId: "t",
      scopeId: "s",
      kind: "cert",
      privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
      certificatePem: certificate.toString("pem"),
      issuedAt: notBefore.toISOString()
    }
  }
}

const respond = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("renewal timing", () => {
  it("renews a token two thirds of the way through its lifetime", () => {
    expect(new Date(renewalTime(token) ?? 0).toISOString()).toBe("2026-01-21T00:00:00.000Z")
  })

  it("never renews a credential without an expiry", () => {
    const { expiresAt: _expiry, ...forever } = token
    expect(credentialLifetime(forever)).toBeUndefined()
    expect(renewalTime(forever)).toBeUndefined()
  })

  it("reads a certificate's lifetime from its validity", async () => {
    const { credential } = await certCredential(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T00:00:00Z")
    )
    expect(new Date(renewalTime(credential) ?? 0).toISOString()).toBe("2026-01-21T00:00:00.000Z")
  })

  it("gives an unreadable certificate no lifetime", () => {
    expect(
      credentialLifetime({ ...token, kind: "cert", certificatePem: "not a certificate" })
    ).toBeUndefined()
  })

  it("refuses an expired credential with what to do", () => {
    expect(() => {
      assertNotExpired(token, Date.parse("2026-02-01T00:00:00Z"))
    }).toThrow(CredentialError)
    expect(() => {
      assertNotExpired(token, Date.parse("2026-02-01T00:00:00Z"))
    }).toThrow(
      "the stored credential expired at 2026-01-31T00:00:00.000Z: claim the device again with a new claim code"
    )
    expect(() => {
      assertNotExpired(token, Date.parse("2026-01-30T00:00:00Z"))
    }).not.toThrow()
  })
})

describe("renewCredential (token)", () => {
  it("presents the token and stores the new secret and expiry", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        respond(201, {
          data: { secret: "qmd_new", credential: { expiresAt: "2026-03-02T00:00:00.000Z" } }
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    const renewed = await renewCredential("https://api.example.com/", token, () =>
      Date.parse("2026-01-21T00:00:00Z")
    )

    expect(renewed).toMatchObject({
      token: "qmd_new",
      issuedAt: "2026-01-21T00:00:00.000Z",
      expiresAt: "2026-03-02T00:00:00.000Z",
      deviceId: "dev_1"
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.example.com/v1/provision/credentials/renew")
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Basic ${btoa("dev_1:qmd_old")}`
    })
  })

  it("marks a credential that can't be renewed as final", async () => {
    vi.stubGlobal("fetch", async () =>
      Promise.resolve(
        respond(409, { message: "credential does not expire, so it cannot be renewed" })
      )
    )
    const error = await renewCredential("https://api.example.com", token).catch(
      (caught: unknown) => caught
    )
    expect(RenewalError.isError(error)).toBe(true)
    expect(error).toMatchObject({
      status: 409,
      retryable: false,
      message: "credential does not expire, so it cannot be renewed"
    })
  })

  it("keeps a rate-limited renewal retryable", async () => {
    vi.stubGlobal("fetch", async () => Promise.resolve(new Response("busy", { status: 429 })))
    await expect(renewCredential("https://api.example.com", token)).rejects.toMatchObject({
      status: 429,
      retryable: true,
      message: "renewal failed with status 429"
    })
  })

  it("reports an unreachable endpoint", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("fetch failed")))
    await expect(renewCredential("https://api.example.com", token)).rejects.toThrow(
      "could not reach the provisioning endpoint to renew the credential"
    )
  })

  it("refuses a token credential without its secret", async () => {
    await expect(
      renewCredential("https://api.example.com", { ...token, token: "" })
    ).rejects.toThrow("stored token credential is missing its secret")
  })

  it("refuses a response without a secret", async () => {
    vi.stubGlobal("fetch", async () => Promise.resolve(respond(201, { data: {} })))
    await expect(renewCredential("https://api.example.com", token)).rejects.toThrow(
      "the renewal response carries no secret"
    )
  })
})

describe("renewCredential (certificate)", () => {
  it("proves the current key over a CSR for a new key", async () => {
    const { credential, keys } = await certCredential(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T00:00:00Z")
    )
    let sent: { certificatePem: string; csrPem: string; signedAt: string; signature: string } = {
      certificatePem: "",
      csrPem: "",
      signedAt: "",
      signature: ""
    }
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string) as typeof sent
      expect(init.headers).toEqual({ "content-type": "application/json" })
      return Promise.resolve(
        respond(201, {
          data: {
            broker: { host: "gw.example.com", port: 8883 },
            certificatePem: "NEW CERT",
            caCertificatePem: "NEW CA"
          }
        })
      )
    })

    const renewed = await renewCredential("https://api.example.com", credential, () =>
      Date.parse("2026-01-21T00:00:00Z")
    )

    expect(sent.certificatePem).toBe(credential.certificatePem)
    expect(sent.signedAt).toBe("2026-01-21T00:00:00.000Z")
    const verified = await crypto.subtle.verify(
      SIGN,
      keys.publicKey,
      Buffer.from(sent.signature, "base64"),
      new TextEncoder().encode(`qualithm-renew-v1\n${sent.signedAt}\n${sent.csrPem}`)
    )
    expect(verified).toBe(true)
    expect(renewed).toMatchObject({
      kind: "cert",
      certificatePem: "NEW CERT",
      caCertificatePem: "NEW CA",
      broker: { host: "gw.example.com", port: 8883 },
      issuedAt: "2026-01-21T00:00:00.000Z"
    })
    expect(renewed.privateKeyPem).not.toBe(credential.privateKeyPem)
    const requested = new Uint8Array(
      new x509.Pkcs10CertificateRequest(sent.csrPem).publicKey.rawData
    )
    const current = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))
    expect(requested).not.toEqual(current)
  })

  it("refuses a certificate credential without its key", async () => {
    const { credential } = await certCredential(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T00:00:00Z")
    )
    const { privateKeyPem: _key, ...keyless } = credential
    await expect(renewCredential("https://api.example.com", keyless)).rejects.toThrow(
      "stored certificate credential is missing its private key or certificate"
    )
  })

  it("refuses a response without a certificate", async () => {
    const { credential } = await certCredential(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-31T00:00:00Z")
    )
    vi.stubGlobal("fetch", async () => Promise.resolve(respond(201, { data: {} })))
    await expect(renewCredential("https://api.example.com", credential)).rejects.toThrow(
      "the renewal response carries no certificate"
    )
  })
})
