import { describe, expect, it, type Mock, vi } from "vitest"

import { EnrollError, RenewalError } from "../../errors.js"
import type { DeviceCredential } from "../../types.js"
import { atApiUrl, parseApiUrl, trimTrailingSlash } from "../../url.js"

describe("trimTrailingSlash", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(trimTrailingSlash("https://api.example.com/")).toBe("https://api.example.com")
    expect(trimTrailingSlash("https://api.example.com///")).toBe("https://api.example.com")
    expect(trimTrailingSlash("https://api.example.com/v1")).toBe("https://api.example.com/v1")
    expect(trimTrailingSlash("")).toBe("")
    expect(trimTrailingSlash("///")).toBe("")
  })

  it("stays linear on a long run of slashes", () => {
    const value = `a${"/".repeat(100_000)}b${"/".repeat(100_000)}`
    expect(trimTrailingSlash(value)).toBe(`a${"/".repeat(100_000)}b`)
  })
})

describe("parseApiUrl", () => {
  it.each([
    ["https://api.sg-sin-a.qualithm.com", "https://api.sg-sin-a.qualithm.com"],
    ["https://api.sg-sin-a.qualithm.com/", "https://api.sg-sin-a.qualithm.com"],
    ["https://api.example.com:8443", "https://api.example.com:8443"],
    ["https://API.Example.com:443/", "https://api.example.com"]
  ])("reads %s as the origin %s", (value, origin) => {
    expect(parseApiUrl(value)).toBe(origin)
  })

  it.each([
    undefined,
    null,
    443,
    { href: "https://api.example.com" },
    "",
    "api.example.com",
    "not a url",
    "https://",
    "http://localhost:3000",
    "http://api.example.com",
    "wss://api.example.com",
    "https://user:secret@api.example.com",
    "https://user@api.example.com",
    "https://api.example.com/v1",
    "https://api.example.com//",
    "https://api.example.com/?zone=sg-sin-a",
    "https://api.example.com?",
    "https://api.example.com/#top",
    "https://api.example.com#",
    "https://api.example.com:0"
  ])("ignores %j", (value) => {
    expect(parseApiUrl(value)).toBeUndefined()
  })
})

describe("atApiUrl", () => {
  const provisioningUrl = "https://api.qualithm.com"
  const zoneUrl = "https://api.sg-sin-a.qualithm.com"
  const claimed: DeviceCredential = {
    deviceId: "d",
    teamId: "t",
    scopeId: "s",
    kind: "token",
    token: "qmd_abc",
    issuedAt: "2026-01-01T00:00:00.000Z"
  }
  const learned: DeviceCredential = { ...claimed, apiUrl: zoneUrl }
  const unreachable = (): RenewalError =>
    new RenewalError("could not reach the provisioning endpoint", {
      cause: new TypeError("fetch failed")
    })
  const enrollUnreachable = (): EnrollError =>
    new EnrollError("could not reach the provisioning endpoint", {
      cause: new TypeError("fetch failed")
    })
  const echo = (): Mock<(baseUrl: string) => Promise<string>> =>
    vi.fn(async (baseUrl: string) => Promise.resolve(baseUrl))
  const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error("the request resolved")
      },
      (error: unknown) => error
    )

  it("calls provisioningUrl when the credential names no API URL", async () => {
    const request = echo()
    await expect(atApiUrl(provisioningUrl, claimed, request)).resolves.toBe(provisioningUrl)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("ignores a stored API URL that isn't an https origin", async () => {
    const request = echo()
    const stored = { ...claimed, apiUrl: "http://api.sg-sin-a.qualithm.com" }
    await expect(atApiUrl(provisioningUrl, stored, request)).resolves.toBe(provisioningUrl)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("calls the API URL the credential names", async () => {
    const request = echo()
    await expect(atApiUrl(provisioningUrl, learned, request)).resolves.toBe(zoneUrl)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["a renewal", unreachable(), RenewalError],
    ["an enrollment", enrollUnreachable(), EnrollError]
  ])(
    "tries %s that got no response once more at provisioningUrl and reports the miss",
    async (_, missed, kind) => {
      const request = vi.fn(async (baseUrl: string) =>
        baseUrl === zoneUrl ? Promise.reject(missed) : Promise.resolve(baseUrl)
      )
      const onFallback = vi.fn()

      await expect(atApiUrl(provisioningUrl, learned, request, onFallback)).resolves.toBe(
        provisioningUrl
      )

      expect(request.mock.calls.map(([baseUrl]) => baseUrl)).toEqual([zoneUrl, provisioningUrl])
      expect(onFallback).toHaveBeenCalledTimes(1)
      const [reported] = onFallback.mock.calls[0] as [Error]
      expect(reported).toBeInstanceOf(kind)
      expect(reported.message).toBe(`no response from ${zoneUrl}: provisioningUrl answered instead`)
      expect(reported.cause).toBe(missed)
    }
  )

  it.each(["https://API.sg-sin-a.qualithm.com/", "https://api.sg-sin-a.qualithm.com//"])(
    "tries the API URL only once when provisioningUrl %s names it too",
    async (sameOrigin) => {
      const failure = unreachable()
      const request = vi.fn(async () => Promise.reject(failure))
      const onFallback = vi.fn()

      await expect(atApiUrl(sameOrigin, learned, request, onFallback)).rejects.toBe(failure)

      expect(request.mock.calls).toEqual([[sameOrigin]])
      expect(onFallback).not.toHaveBeenCalled()
    }
  )

  it.each([500, 503, 530])(
    "tries a renewal answered %s once more at provisioningUrl and reports the status",
    async (status) => {
      const failure = new RenewalError(`renewal failed with status ${String(status)}`, { status })
      const request = vi.fn(async (baseUrl: string) =>
        baseUrl === zoneUrl ? Promise.reject(failure) : Promise.resolve(baseUrl)
      )
      const onFallback = vi.fn()

      await expect(atApiUrl(provisioningUrl, learned, request, onFallback)).resolves.toBe(
        provisioningUrl
      )

      expect(request.mock.calls.map(([baseUrl]) => baseUrl)).toEqual([zoneUrl, provisioningUrl])
      const [reported] = onFallback.mock.calls[0] as [Error]
      expect(reported.message).toBe(
        `${zoneUrl} answered ${String(status)}: provisioningUrl answered instead`
      )
      expect(reported.cause).toBe(failure)
    }
  )

  it.each([
    ["a client error", new RenewalError("renewal failed with status 401", { status: 401 })],
    ["a rate limit", new RenewalError("renewal failed with status 429", { status: 429 })],
    ["a response without a secret", new RenewalError("the renewal response carries no secret")],
    ["an error that isn't a request's", new Error("disk full")]
  ])("doesn't try again after %s", async (_, failure) => {
    const request = vi.fn(async () => Promise.reject(failure))
    const onFallback = vi.fn()
    await expect(atApiUrl(provisioningUrl, learned, request, onFallback)).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onFallback).not.toHaveBeenCalled()
  })

  it.each([
    ["no response either", unreachable(), "could not reach the provisioning endpoint"],
    ["an error that isn't a request's", new Error("disk full"), "disk full"],
    ["a rejection that isn't an error", "offline", "offline"]
  ])(
    "keeps both failures when provisioningUrl gives %s",
    async (_, last: unknown, reason: string) => {
      const missed = unreachable()
      const request = vi
        .fn<(baseUrl: string) => Promise<string>>()
        .mockRejectedValueOnce(missed)
        .mockRejectedValueOnce(last)
      const onFallback = vi.fn()

      const error = await rejection(atApiUrl(provisioningUrl, learned, request, onFallback))

      expect(error).toBeInstanceOf(RenewalError)
      const renewal = error as RenewalError
      expect(renewal.message).toBe(
        `no response from ${zoneUrl}, then at provisioningUrl: ${reason}`
      )
      expect(renewal.status).toBeUndefined()
      expect(renewal.cause).toBeInstanceOf(AggregateError)
      const { errors } = renewal.cause as AggregateError
      expect(errors).toHaveLength(2)
      expect(errors[0]).toBe(missed)
      expect(errors[1]).toBe(last)
      expect(onFallback).not.toHaveBeenCalled()
    }
  )

  it("keeps a renewal refused at provisioningUrl final", async () => {
    const refused = new RenewalError("credential revoked", { status: 409 })
    const request = vi
      .fn<(baseUrl: string) => Promise<string>>()
      .mockRejectedValueOnce(unreachable())
      .mockRejectedValueOnce(refused)

    const error = await rejection(atApiUrl(provisioningUrl, learned, request))

    expect(error).toBeInstanceOf(RenewalError)
    expect(error).toMatchObject({
      message: `no response from ${zoneUrl}, then at provisioningUrl: credential revoked`,
      status: 409,
      retryable: false
    })
  })

  it("keeps an enrollment's error class and status when both URLs fail", async () => {
    const request = vi
      .fn<(baseUrl: string) => Promise<string>>()
      .mockRejectedValueOnce(enrollUnreachable())
      .mockRejectedValueOnce(new EnrollError("unauthorized", { status: 401 }))

    const error = await rejection(atApiUrl(provisioningUrl, learned, request))

    expect(error).toBeInstanceOf(EnrollError)
    expect(error).toMatchObject({
      message: `no response from ${zoneUrl}, then at provisioningUrl: unauthorized`,
      status: 401
    })
  })
})
