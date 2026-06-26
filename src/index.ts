/**
 * Qualithm device SDK — one-call claim, credential persistence, and
 * MQTT-over-TLS connectivity for JavaScript and TypeScript runtimes.
 *
 * @packageDocumentation
 */

// Claim
export type { ClaimRequest } from "./claim.js"
export { claimDevice } from "./claim.js"

// CSR / certificate path
export type { DeviceKeyMaterial } from "./csr.js"
export { generateDeviceCsr } from "./csr.js"

// Device
export type { ErrorListener, MessageListener, StateListener } from "./device.js"
export { Device } from "./device.js"

// Errors
export { ClaimError, ConnectionError, CredentialError, QualithmDeviceError } from "./errors.js"

// Stores
export { createFileCredentialStore, createMemoryCredentialStore } from "./store.js"

// Types
export type {
  BrokerOptions,
  ConnectionState,
  CredentialKind,
  CredentialStore,
  DeviceCredential,
  DeviceOptions
} from "./types.js"
