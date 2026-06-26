/**
 * Testing utilities for `@qualithm/device`.
 *
 * This subpath export (`@qualithm/device/testing`) provides helpers for testing
 * code that depends on the SDK — a recording credential store and ready-made
 * credential fixtures — so downstream apps can unit-test provisioning and
 * persistence logic without a broker or the network.
 *
 * @example
 * ```ts
 * import { createRecordingCredentialStore, createTestCredential } from "@qualithm/device/testing"
 *
 * const store = createRecordingCredentialStore()
 * await store.save(createTestCredential())
 * expect(store.calls.map((c) => c.op)).toEqual(["save"])
 * ```
 *
 * @packageDocumentation
 */

import { createMemoryCredentialStore } from "../store.js"
import type { CredentialStore, DeviceCredential } from "../types.js"

// ============================================================================
// Recording credential store
// ============================================================================

/** The kind of operation performed against a {@link CredentialStore}. */
export type CredentialStoreOp = "load" | "save" | "clear"

/** A recorded call against a {@link RecordingCredentialStore}. */
export type CredentialStoreCall = {
  /** Which store method was invoked. */
  op: CredentialStoreOp
  /** The credential passed to `save`, if any. */
  credential?: DeviceCredential
}

/** A {@link CredentialStore} that records every call for assertions. */
export type RecordingCredentialStore = CredentialStore & {
  /** All recorded calls, in order. */
  calls: CredentialStoreCall[]
  /** Reset the recorded calls. */
  clearCalls: () => void
}

/**
 * Create an in-memory credential store that records every `load`/`save`/`clear`
 * call, for asserting persistence behaviour in tests.
 */
export function createRecordingCredentialStore(): RecordingCredentialStore {
  const inner = createMemoryCredentialStore()
  const calls: CredentialStoreCall[] = []

  return {
    load: async (): Promise<DeviceCredential | null> => {
      calls.push({ op: "load" })
      return inner.load()
    },
    save: async (credential: DeviceCredential): Promise<void> => {
      calls.push({ op: "save", credential })
      await inner.save(credential)
    },
    clear: async (): Promise<void> => {
      calls.push({ op: "clear" })
      await inner.clear()
    },
    calls,
    clearCalls: () => {
      calls.length = 0
    }
  }
}

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Build a {@link DeviceCredential} fixture, overriding any fields.
 *
 * @param overrides - Partial fields to merge over the default token credential.
 */
export function createTestCredential(overrides: Partial<DeviceCredential> = {}): DeviceCredential {
  return {
    deviceId: "11111111-1111-1111-1111-111111111111",
    teamId: "team-1",
    spaceId: "space-1",
    kind: "token",
    token: "qmd_testsecret",
    issuedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  }
}

/** A named credential fixture. */
export type CredentialFixture = {
  /** Human description of the scenario. */
  description: string
  /** The credential under test. */
  credential: DeviceCredential
}

/** Ready-made credential fixtures for common scenarios. */
export const testFixtures = {
  /** Credential test cases. */
  credentials: [
    {
      description: "token credential",
      credential: createTestCredential()
    },
    {
      description: "expiring token credential",
      credential: createTestCredential({ expiresAt: "2030-01-01T00:00:00.000Z" })
    }
  ] satisfies CredentialFixture[]
}
