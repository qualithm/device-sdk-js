/**
 * Qualithm Device SDK — one-call claim, credential persistence, and
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

// Certificate enrollment
export type { EnrollRequest } from "./enroll.js"
export { enrollDeviceCertificate } from "./enroll.js"

// Device
export type { CommandHandler, ErrorListener, MessageListener, StateListener } from "./device.js"
export { Device } from "./device.js"

// Errors
export {
  CapabilityError,
  ClaimError,
  CommandError,
  ConnectionError,
  CredentialError,
  EnrollError,
  PayloadTooLargeError,
  ProvisioningError,
  QualithmDeviceError
} from "./errors.js"

// Stores
export { createFileCredentialStore, createMemoryCredentialStore } from "./store.js"

// Soft-AP provisioning server (Decision qualithm/pm#763)
export type {
  AccessPointController,
  ClaimExchange,
  HomeNetwork,
  HomeNetworkController,
  OnboardingAccepted,
  ProvisionedIdentity,
  ProvisioningInfo,
  ProvisioningServerOptions,
  ProvisioningServerState
} from "./provision-server.js"
export { ProvisioningServer } from "./provision-server.js"

// Reference setup access point for the Pi/Node path (qualithm/pm#201)
export type { HotspotCommands, NmcliAccessPointOptions } from "./access-point.js"
export { createNmcliAccessPoint, hotspotCommands } from "./access-point.js"

// Types
export type {
  BrokerEndpoint,
  BrokerOptions,
  ConnectionState,
  CredentialKind,
  CredentialStore,
  DeviceCredential,
  DeviceOptions
} from "./types.js"

// Capabilities & commands (Decision qualithm/pm#747)
export type {
  CapabilityDeclaration,
  CapabilityManifest,
  CapabilityType,
  CommandPayload,
  EnumDeclaration,
  JsonValue,
  ManifestCapability,
  OnOffDeclaration,
  RangeDeclaration,
  SensorDeclaration,
  TriggerDeclaration
} from "./capability.js"
export { isValidCapabilityKey } from "./capability.js"
