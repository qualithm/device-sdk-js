import { describe, expect, it } from "vitest"

import { generateDeviceCsr } from "../../csr.js"

describe("generateDeviceCsr", () => {
  it("produces a PKCS#8 private key and a PKCS#10 CSR in PEM", async () => {
    const { privateKeyPem, csrPem } = await generateDeviceCsr(
      "11111111-1111-1111-1111-111111111111"
    )

    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY")
    expect(csrPem).toContain("BEGIN CERTIFICATE REQUEST")
  })
})
