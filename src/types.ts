/**
 * Public types for the Qualithm device SDK.
 *
 * @packageDocumentation
 */

/** Which credential mechanism a device authenticates with. */
export type CredentialKind = "token" | "cert"

/**
 * A device credential persisted across restarts.
 *
 * The credential is written to the {@link CredentialStore} after a successful
 * claim so that a power cycle reconnects without re-claiming (claim codes are
 * single-use). For the token path only {@link DeviceCredential.token} is set;
 * for the certificate path the key/cert/chain fields are set instead.
 */
export type DeviceCredential = {
  /** The device's stable identity (a UUID), used as the MQTT client id. */
  deviceId: string
  /** The owning team (tenant boundary). */
  teamId: string
  /** The space the device belongs to. */
  spaceId: string
  /** Which authentication mechanism this credential uses. */
  kind: CredentialKind
  /** Bearer secret for the token path; presented as the MQTT password. */
  token?: string
  /** PEM-encoded private key for the certificate path. */
  privateKeyPem?: string
  /** PEM-encoded device certificate for the certificate path. */
  certificatePem?: string
  /** PEM-encoded issuing CA chain, so the device can assemble its chain. */
  caCertificatePem?: string
  /** ISO-8601 time the credential was issued/stored. */
  issuedAt: string
  /** ISO-8601 expiry, when the credential is time-bounded. */
  expiresAt?: string
}

/**
 * Lifecycle state of a {@link Device} connection.
 *
 * `idle` → `provisioning` (first boot only) → `connecting` → `connected`;
 * a dropped link transitions to `reconnecting` until the next `connected`.
 * `closed` is terminal for an explicit {@link Device.disconnect}.
 */
export type ConnectionState =
  | "idle"
  | "provisioning"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"

/**
 * Pluggable, restart-safe credential persistence.
 *
 * The default implementation is a crash-safe file store
 * ({@link createFileCredentialStore}); embedded targets can supply their own
 * backend (flash/NVS, secure element, keychain) by implementing this contract.
 */
export type CredentialStore = {
  /** Load the persisted credential, or `null` when none exists yet. */
  load: () => Promise<DeviceCredential | null>
  /** Persist the credential atomically (durable across power loss). */
  save: (credential: DeviceCredential) => Promise<void>
  /** Remove any persisted credential. */
  clear: () => Promise<void>
}

/** MQTT gateway connection settings. */
export type BrokerOptions = {
  /** Gateway host, e.g. `gw.de-fra-a.qualithm.com`. */
  host: string
  /** TLS port. Defaults to `8883`. */
  port?: number
  /** PEM CA bundle used to trust the gateway server certificate. */
  ca?: string | string[]
  /** Whether to reject an untrusted server certificate. Defaults to `true`. */
  rejectUnauthorized?: boolean
}

/** Options for constructing a {@link Device}. */
export type DeviceOptions = {
  /** Provisioning API base URL, e.g. `https://api.qualithm.com`. */
  provisioningUrl: string
  /** MQTT gateway connection settings. */
  broker: BrokerOptions
  /** One-time claim code, used only on first boot when no credential is stored. */
  claimCode?: string
  /** Optional human-friendly device name set at claim time. */
  name?: string
  /** Where the credential is persisted. Defaults to a crash-safe file store. */
  store?: CredentialStore
  /** Reconnect backoff in milliseconds. Defaults to `1000`. */
  reconnectPeriodMs?: number
  /** Keep-alive interval in seconds. Defaults to `60`. */
  keepaliveSeconds?: number
}
