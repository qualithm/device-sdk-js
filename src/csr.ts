/**
 * On-device key and CSR generation for the certificate (mTLS) credential path.
 *
 * The device generates an ECDSA P-256 key pair and a PKCS#10 certificate
 * signing request. The CSR is submitted to an operator-side mint flow; the
 * returned certificate is then stored alongside the private key. The subject CN
 * is set to the device id, though the platform re-binds the CN at signing time
 * regardless, so the CSR only needs to carry the public key and proof of
 * possession.
 */

import "reflect-metadata"

import * as x509 from "@peculiar/x509"

x509.cryptoProvider.set(crypto)

const EC_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" }
const EC_SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" }

/** Generated key material for the certificate path. */
export type DeviceKeyMaterial = {
  /** PEM-encoded PKCS#8 private key — persist this securely. */
  privateKeyPem: string
  /** PEM-encoded PKCS#10 certificate signing request — submit this to mint. */
  csrPem: string
}

/** Escape RFC 4514 special characters in a distinguished-name value. */
const escapeName = (value: string): string => value.replace(/([,+"\\<>;=])/g, "\\$1")

/**
 * Generate an ECDSA P-256 key pair and a CSR for the given device.
 *
 * @param deviceId - The device's stable identity, used as the subject CN.
 */
export const generateDeviceCsr = async (deviceId: string): Promise<DeviceKeyMaterial> => {
  const keys = await crypto.subtle.generateKey(EC_KEY_ALGORITHM, true, ["sign", "verify"])
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${escapeName(deviceId)}`,
    keys,
    signingAlgorithm: EC_SIGN_ALGORITHM
  })
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey)
  return {
    privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
    csrPem: csr.toString("pem")
  }
}
