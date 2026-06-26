/**
 * Credential persistence backends.
 *
 * The file store is crash-safe: it writes to a temp file, `fsync`s it, then
 * atomically renames into place, so a power loss mid-write can never leave a
 * half-written credential. The memory store is for tests and ephemeral runs.
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { CredentialError } from "./errors.js"
import type { CredentialStore, DeviceCredential } from "./types.js"

/** True when an unknown error is a filesystem "not found". */
const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

/**
 * A crash-safe, file-backed credential store.
 *
 * @param path - Absolute or relative path to the credential file. Parent
 *   directories are created on first write.
 */
export const createFileCredentialStore = (path: string): CredentialStore => ({
  load: async (): Promise<DeviceCredential | null> => {
    try {
      const raw = await readFile(path, "utf8")
      return JSON.parse(raw) as DeviceCredential
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }
      throw new CredentialError(`Failed to read credential at ${path}`, { cause: error })
    }
  },

  save: async (credential: DeviceCredential): Promise<void> => {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(tmp, "w")
    try {
      await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  },

  clear: async (): Promise<void> => {
    await rm(path, { force: true })
  }
})

/** An in-memory credential store, primarily for tests and ephemeral runs. */
export const createMemoryCredentialStore = (): CredentialStore => {
  let current: DeviceCredential | null = null
  return {
    load: async (): Promise<DeviceCredential | null> => Promise.resolve(current),
    save: async (credential: DeviceCredential): Promise<void> => {
      current = credential
      return Promise.resolve()
    },
    clear: async (): Promise<void> => {
      current = null
      return Promise.resolve()
    }
  }
}
