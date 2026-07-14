import { describe, expect, it } from "vitest"

import {
  ClaimError,
  ConnectionError,
  CredentialError,
  EnrollError,
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

    expect(QualithmDeviceError.isError(new Error("plain"))).toBe(false)
    expect(new ClaimError("x").status).toBeUndefined()
  })
})
