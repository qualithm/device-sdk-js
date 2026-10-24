import { describe, expect, it } from "vitest"

import { generateDeviceCsr } from "../../csr.js"

describe("generateDeviceCsr", () => {
  it("produces a PKCS#8 private key and a PKCS#10 CSR in PEM", async () => {
    const { privateKeyPem, csrPem } = await generateDeviceCsr("dev_01JAYQ4T7Z9K3M5N8P2R6S0V1W")

    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY")
    expect(csrPem).toContain("BEGIN CERTIFICATE REQUEST")
  })
})
