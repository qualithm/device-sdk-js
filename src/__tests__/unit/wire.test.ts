/**
 * The shared wire fixtures: the same JSON cases the Python SDK tests against,
 * so both SDKs hold to one contract with the platform.
 */

import "reflect-metadata"

import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as x509 from "@peculiar/x509"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildManifest,
  type CapabilityDeclaration,
  decodeCommandPayload,
  isValidCapabilityKey
} from "../../capability.js"
import { claimDevice, parseBroker } from "../../claim.js"
import { enrollDeviceCertificate } from "../../enroll.js"
import { CapabilityError, ClaimError, EnrollError, RenewalError } from "../../errors.js"
import { renewCredential } from "../../renew.js"
import { createFileCredentialStore } from "../../store.js"
import type { DeviceCredential } from "../../types.js"

x509.cryptoProvider.set(crypto)

const wire = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../wire/${name}.json`, import.meta.url), "utf8"))

type ErrorCase = {
  description: string
  status: number
  body?: unknown
  raw?: string
  message: string
}

const respond = (status: number, body: unknown, raw?: string): Response =>
  new Response(raw ?? JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const errorResponse = (error: ErrorCase): Response => respond(error.status, error.body, error.raw)

const ISSUED_AT = "2026-01-01T00:00:00.000Z"
const RENEWED_AT = "2026-01-21T00:00:00.000Z"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("wire: claim", () => {
  type Fixture = {
    request: { code: string }
    cases: { description: string; status: number; body: unknown; credential: DeviceCredential }[]
    errors: ErrorCase[]
  }
  const fixture = wire("claim") as Fixture

  for (const c of fixture.cases) {
    it(c.description, async () => {
      vi.useFakeTimers({ now: Date.parse(ISSUED_AT), toFake: ["Date"] })
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(c.status, c.body)))

      const credential = await claimDevice("https://api.example.com/", fixture.request)

      expect(credential).toEqual({ ...c.credential, issuedAt: ISSUED_AT })
    })
  }

  for (const error of fixture.errors) {
    it(`reports ${error.description}`, async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(error)))

      const caught = await claimDevice("https://api.example.com", fixture.request).catch(
        (e: unknown) => e
      )

      expect(caught).toBeInstanceOf(ClaimError)
      expect((caught as ClaimError).message).toBe(error.message)
      expect((caught as ClaimError).status).toBe(error.status)
    })
  }
})

describe("wire: enroll", () => {
  type Fixture = {
    claimed: DeviceCredential
    authorization: string
    cases: { description: string; status: number; body: unknown; broker: unknown }[]
    errors: ErrorCase[]
  }
  const fixture = wire("enroll") as Fixture

  for (const c of fixture.cases) {
    it(c.description, async () => {
      const fetchMock = vi.fn().mockResolvedValue(respond(c.status, c.body))
      vi.stubGlobal("fetch", fetchMock)

      const credential = await enrollDeviceCertificate("https://api.example.com/", fixture.claimed)

      expect(credential.kind).toBe("cert")
      expect(credential.certificatePem).toBe("cert-pem")
      expect(credential.caCertificatePem).toBe("ca-pem")
      expect(credential.token).toBeUndefined()
      expect(credential.broker).toEqual(c.broker)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://api.example.com/v1/provision/credentials/cert")
      expect((init.headers as Record<string, string>).authorization).toBe(fixture.authorization)
    })
  }

  for (const error of fixture.errors) {
    it(`reports ${error.description}`, async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(error)))

      const caught = await enrollDeviceCertificate(
        "https://api.example.com",
        fixture.claimed
      ).catch((e: unknown) => e)

      expect(caught).toBeInstanceOf(EnrollError)
      expect((caught as EnrollError).message).toBe(error.message)
      expect((caught as EnrollError).status).toBe(error.status)
    })
  }
})

describe("wire: capabilities", () => {
  type Fixture = {
    declarations: CapabilityDeclaration[]
    manifest: unknown
    optionalOmitted: { declarations: CapabilityDeclaration[]; manifest: unknown }
    invalid: unknown[]
  }
  const fixture = wire("capabilities") as Fixture

  it("builds the manifest for every capability type", () => {
    expect(buildManifest(fixture.declarations)).toEqual(fixture.manifest)
  })

  it("omits unset optional config", () => {
    expect(buildManifest(fixture.optionalOmitted.declarations)).toEqual(
      fixture.optionalOmitted.manifest
    )
  })

  for (const declarations of fixture.invalid) {
    it(`rejects ${JSON.stringify(declarations)}`, () => {
      expect(() => buildManifest(declarations as CapabilityDeclaration[])).toThrow(CapabilityError)
    })
  }
})

describe("wire: broker", () => {
  type Fixture = { valid: { value: unknown; broker: unknown }[]; invalid: unknown[] }
  const fixture = wire("broker") as Fixture

  for (const c of fixture.valid) {
    it(`reads ${JSON.stringify(c.value)}`, () => {
      expect(parseBroker(c.value)).toEqual(c.broker)
    })
  }

  for (const value of fixture.invalid) {
    it(`ignores ${JSON.stringify(value)}`, () => {
      expect(parseBroker(value)).toBeUndefined()
    })
  }
})

describe("wire: command", () => {
  type Fixture = {
    decoded: { payload: string; trigger: boolean; value?: unknown }[]
    rejected: string[]
    validKeys: string[]
    invalidKeys: string[]
  }
  const fixture = wire("command") as Fixture
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

  for (const c of fixture.decoded) {
    it(`decodes ${c.payload}`, () => {
      expect(decodeCommandPayload(encode(c.payload))).toEqual(
        c.trigger ? { kind: "trigger" } : { kind: "value", value: c.value }
      )
    })
  }

  for (const payload of fixture.rejected) {
    it(`rejects ${payload}`, () => {
      expect(() => decodeCommandPayload(encode(payload))).toThrow()
    })
  }

  for (const key of fixture.validKeys) {
    it(`accepts key ${JSON.stringify(key)}`, () => {
      expect(isValidCapabilityKey(key)).toBe(true)
    })
  }

  for (const key of fixture.invalidKeys) {
    it(`refuses key ${JSON.stringify(key)}`, () => {
      expect(isValidCapabilityKey(key)).toBe(false)
    })
  }
})

describe("wire: credential", () => {
  type Fixture = { credentials: { description: string; credential: DeviceCredential }[] }
  const stored = [
    ...(wire("credential") as Fixture).credentials,
    {
      description: "certificate credential",
      credential: (wire("renew") as { cert: { current: DeviceCredential } }).cert.current
    }
  ]

  for (const c of stored) {
    it(`round-trips a ${c.description} through the file store`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "wire-"))
      try {
        const store = createFileCredentialStore(join(dir, "credential.json"))
        await store.save(c.credential)
        expect(await store.load()).toEqual(c.credential)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})

describe("wire: renew", () => {
  type Fixture = {
    proofTag: string
    token: { current: DeviceCredential; authorization: string; status: number; body: unknown }
    cert: { current: DeviceCredential; status: number; body: unknown }
    errors: ErrorCase[]
  }
  const fixture = wire("renew") as Fixture
  const now = (): number => Date.parse(RENEWED_AT)

  it("renews a token with its own Basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(fixture.token.status, fixture.token.body))
    vi.stubGlobal("fetch", fetchMock)

    const renewed = await renewCredential("https://x", fixture.token.current, now)

    expect(renewed).toEqual({
      ...fixture.token.current,
      token: "qmd_new",
      issuedAt: RENEWED_AT,
      expiresAt: "2026-03-02T00:00:00.000Z"
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://x/v1/provision/credentials/renew")
    expect((init.headers as Record<string, string>).authorization).toBe(fixture.token.authorization)
    expect(init.body).toBeUndefined()
  })

  it("renews a certificate with a signed CSR for a new key", async () => {
    // The fixture's key is an opaque placeholder; this SDK signs with real
    // WebCrypto, so the test supplies a real key in its place.
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify"
    ])
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey)
    const current = {
      ...fixture.cert.current,
      privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY")
    }
    const fetchMock = vi.fn().mockResolvedValue(respond(fixture.cert.status, fixture.cert.body))
    vi.stubGlobal("fetch", fetchMock)

    const renewed = await renewCredential("https://x", current, now)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    const sent = JSON.parse(init.body as string) as {
      certificatePem: string
      csrPem: string
      signedAt: string
      signature: string
    }
    expect(Object.keys(sent).sort()).toEqual(["certificatePem", "csrPem", "signature", "signedAt"])
    expect(sent.certificatePem).toBe("old-cert")
    expect(sent.signedAt).toBe(RENEWED_AT)
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      Buffer.from(sent.signature, "base64"),
      new TextEncoder().encode(`${fixture.proofTag}\n${sent.signedAt}\n${sent.csrPem}`)
    )
    expect(verified).toBe(true)

    expect(renewed.privateKeyPem).not.toBe(current.privateKeyPem)
    expect(renewed).toEqual({
      ...fixture.cert.current,
      privateKeyPem: renewed.privateKeyPem,
      certificatePem: "new-cert",
      caCertificatePem: "ca-pem",
      issuedAt: RENEWED_AT,
      expiresAt: "2026-03-02T00:00:00.000Z",
      broker: { host: "gw.sg-sin-a.qualithm.com", port: 8883 }
    })
  })

  for (const error of fixture.errors) {
    it(`reports ${error.description}`, async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(error)))

      const caught = await renewCredential("https://x", fixture.token.current, now).catch(
        (e: unknown) => e
      )

      expect(caught).toBeInstanceOf(RenewalError)
      expect((caught as RenewalError).message).toBe(error.message)
      expect((caught as RenewalError).status).toBe(error.status)
    })
  }
})
