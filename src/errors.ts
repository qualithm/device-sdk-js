/**
 * Error hierarchy for the Qualithm device SDK.
 *
 * All errors extend {@link QualithmDeviceError}. Use the static `isError()`
 * method on each class for type narrowing without `instanceof`.
 *
 * @example
 * ```ts
 * if (ClaimError.isError(err)) {
 *   // err is ClaimError
 * }
 * ```
 */

const DEVICE_ERROR_TAG = "QualithmDeviceError" as const
const CLAIM_ERROR_TAG = "ClaimError" as const
const CREDENTIAL_ERROR_TAG = "CredentialError" as const
const CONNECTION_ERROR_TAG = "ConnectionError" as const

/** Base error for all device SDK errors. */
export class QualithmDeviceError extends Error {
  /** Discriminant tag for identifying error types without `instanceof`. */
  readonly tag: string = DEVICE_ERROR_TAG

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "QualithmDeviceError"
  }

  /** Type-narrowing check for any device SDK error. */
  static isError(value: unknown): value is QualithmDeviceError {
    return value instanceof QualithmDeviceError
  }
}

/** Failure exchanging a claim code at the provisioning endpoint. */
export class ClaimError extends QualithmDeviceError {
  /** Discriminant tag — always `"ClaimError"`. */
  override readonly tag = CLAIM_ERROR_TAG

  /** HTTP status returned by the provisioning endpoint, if any. */
  readonly status: number | undefined

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options)
    this.name = "ClaimError"
    this.status = options?.status
  }

  /** Type-narrowing check for ClaimError. */
  static override isError(value: unknown): value is ClaimError {
    return value instanceof ClaimError
  }
}

/** Missing, invalid, or unreadable persisted credential. */
export class CredentialError extends QualithmDeviceError {
  /** Discriminant tag — always `"CredentialError"`. */
  override readonly tag = CREDENTIAL_ERROR_TAG

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CredentialError"
  }

  /** Type-narrowing check for CredentialError. */
  static override isError(value: unknown): value is CredentialError {
    return value instanceof CredentialError
  }
}

/** Failure establishing or maintaining the MQTT-over-TLS connection. */
export class ConnectionError extends QualithmDeviceError {
  /** Discriminant tag — always `"ConnectionError"`. */
  override readonly tag = CONNECTION_ERROR_TAG

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ConnectionError"
  }

  /** Type-narrowing check for ConnectionError. */
  static override isError(value: unknown): value is ConnectionError {
    return value instanceof ConnectionError
  }
}
