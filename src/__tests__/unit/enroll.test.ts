import { afterEach, describe, expect, it, vi } from "vitest"

import { enrollDeviceCertificate } from "../../enroll.js"
import { EnrollError } from "../../errors.js"
import type { DeviceCredential } from "../../types.js"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const tokenCredential: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "t",
  spaceId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: "2026-01-01T00:00:00.000Z"
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("enrollDeviceCertificate", () => {
  it("submits a CSR authenticated as Basic deviceId:token and returns a cert credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { certificatePem: "cert-pem", caCertificatePem: "ca-pem" }
      })
    )

    const credential = await enrollDeviceCertificate("https://api.example.com/", tokenCredential)

    expect(credential.kind).toBe("cert")
    expect(credential.deviceId).toBe(tokenCredential.deviceId)
    expect(credential.certificatePem).toBe("cert-pem")
    expect(credential.caCertificatePem).toBe("ca-pem")
    expect(credential.privateKeyPem).toContain("BEGIN PRIVATE KEY")

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/provision/credentials/cert")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${btoa(`${tokenCredential.deviceId}:qmd_secret`)}`)
    const body = JSON.parse(init.body as string) as { csrPem: string }
    expect(body.csrPem).toContain("BEGIN CERTIFICATE REQUEST")
  })

  it("throws EnrollError when the credential has no token", async () => {
    const certCredential: DeviceCredential = { ...tokenCredential, kind: "cert", token: undefined }
    await expect(
      enrollDeviceCertificate("https://api.example.com", certCredential)
    ).rejects.toBeInstanceOf(EnrollError)
  })

  it("throws EnrollError on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ message: "bad csr" }, 400))

    await expect(
      enrollDeviceCertificate("https://api.example.com", tokenCredential)
    ).rejects.toBeInstanceOf(EnrollError)
  })

  it("throws EnrollError when the endpoint is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))

    await expect(
      enrollDeviceCertificate("https://api.example.com", tokenCredential)
    ).rejects.toBeInstanceOf(EnrollError)
  })
})
