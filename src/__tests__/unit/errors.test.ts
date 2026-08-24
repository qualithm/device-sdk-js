import { describe, expect, it } from "vitest"

import {
  ClaimError,
  ConnectionError,
  CredentialError,
  EnrollError,
  PayloadTooLargeError,
  QualithmDeviceError
} from "../../errors.js"

describe("error hierarchy", () => {
  it("narrows with static isError and exposes tags", () => {
    const claim = new ClaimError("bad", { status: 401 })
    expect(ClaimError.isError(claim)).toBe(true)
    expect(QualithmDeviceError.isError(claim)).toBe(true)
    expect(claim.status).toBe(401)
    expect(claim.tag).toBe("ClaimError")

    const credential = new CredentialError("missing")
    expect(CredentialError.isError(credential)).toBe(true)
    expect(ClaimError.isError(credential)).toBe(false)
    expect(credential.tag).toBe("CredentialError")

    const connection = new ConnectionError("down")
    expect(ConnectionError.isError(connection)).toBe(true)
    expect(connection.tag).toBe("ConnectionError")

    const enroll = new EnrollError("bad csr", { status: 400 })
    expect(EnrollError.isError(enroll)).toBe(true)
    expect(ConnectionError.isError(enroll)).toBe(false)
    expect(enroll.status).toBe(400)
    expect(enroll.tag).toBe("EnrollError")
    expect(new EnrollError("x").status).toBeUndefined()

    const tooLarge = new PayloadTooLargeError("too big", { maxBytes: 8, actualBytes: 9 })
    expect(PayloadTooLargeError.isError(tooLarge)).toBe(true)
    expect(QualithmDeviceError.isError(tooLarge)).toBe(true)
    expect(ClaimError.isError(tooLarge)).toBe(false)
    expect(tooLarge.tag).toBe("PayloadTooLargeError")
    expect(tooLarge.maxBytes).toBe(8)
    expect(tooLarge.actualBytes).toBe(9)
    // The byte fields default to 0 when options are omitted.
    expect(new PayloadTooLargeError("x").maxBytes).toBe(0)

    expect(QualithmDeviceError.isError(new Error("plain"))).toBe(false)
    expect(new ClaimError("x").status).toBeUndefined()
  })
})
