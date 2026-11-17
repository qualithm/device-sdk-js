import { EventEmitter } from "node:events"

import { connect, type MqttClient } from "mqtt"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Device } from "../../device.js"
import { CredentialError, RenewalError } from "../../errors.js"
import { createMemoryCredentialStore } from "../../store.js"
import type { CredentialStore, DeviceCredential } from "../../types.js"

vi.mock("mqtt", () => ({ connect: vi.fn() }))

class FakeMqttClient extends EventEmitter {
  options: Record<string, unknown> = {}
  publish(_topic: string, _message: unknown, _opts: unknown, cb: (error?: Error) => void): void {
    cb()
  }
  subscribe(_topic: unknown, _opts: unknown, cb: (error: Error | null) => void): void {
    cb(null)
  }
  end(_force?: boolean, _opts?: unknown, cb?: () => void): void {
    cb?.()
  }
}

const DAY_MS = 86_400_000
const ISSUED = Date.parse("2026-01-01T00:00:00Z")
const RENEW_PATH = "/v1/provision/credentials/renew"
const ZONE_URL = "https://api.sg-sin-a.qualithm.com"

const credential: DeviceCredential = {
  deviceId: "dev_1",
  teamId: "t",
  scopeId: "s",
  kind: "token",
  token: "qmd_old",
  issuedAt: new Date(ISSUED).toISOString(),
  expiresAt: new Date(ISSUED + 30 * DAY_MS).toISOString()
}

const renewedBody = (secret: string, now: number, apiUrl?: string): Response =>
  new Response(
    JSON.stringify({
      data: {
        secret,
        credential: { expiresAt: new Date(now + 30 * DAY_MS).toISOString() },
        ...(apiUrl !== undefined && { apiUrl })
      }
    }),
    { status: 201 }
  )

const newDevice = (store: CredentialStore): Device =>
  new Device({
    capabilities: [{ key: "power", type: "onoff" }],
    provisioningUrl: "https://api.example.com",
    broker: { host: "gw.example.com" },
    store
  })

const seeded = async (stored: DeviceCredential): Promise<CredentialStore> => {
  const store = createMemoryCredentialStore()
  await store.save(stored)
  return store
}

const connectWith = async (device: Device, client: FakeMqttClient): Promise<void> => {
  vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
  const pending = device.connect()
  await vi.advanceTimersByTimeAsync(0)
  client.emit("connect", { properties: {} })
  await pending
}

beforeEach(() => {
  vi.useFakeTimers({ now: ISSUED, toFake: ["setTimeout", "clearTimeout", "Date"] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("Device credential renewal", () => {
  it("renews before expiry and presents the new token on the next reconnect", async () => {
    const fetchMock = vi.fn(async () => Promise.resolve(renewedBody("qmd_new", Date.now())))
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded(credential)
    const device = newDevice(store)
    const client = new FakeMqttClient()
    await connectWith(device, client)

    await vi.advanceTimersByTimeAsync(19 * DAY_MS)
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2 * DAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await store.load())?.token).toBe("qmd_new")
    expect(device.identity?.token).toBe("qmd_new")
    expect(client.options).toMatchObject({ username: "dev_1", password: "qmd_new" })

    // The renewed credential is renewed again two thirds into its own lifetime.
    await vi.advanceTimersByTimeAsync(20 * DAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await device.disconnect()
  })

  it("keeps the old credential when a renewal is interrupted, then retries", async () => {
    vi.stubGlobal("fetch", async () => Promise.resolve(renewedBody("qmd_new", Date.now())))
    const store = await seeded(credential)
    const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("power lost"))
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)
    expect(errors.map((error) => error.message)).toEqual(["power lost"])
    expect((await store.load())?.token).toBe("qmd_old")
    expect(device.identity?.token).toBe("qmd_old")

    await vi.advanceTimersByTimeAsync(60_000)
    expect(save).toHaveBeenCalledTimes(2)
    expect((await store.load())?.token).toBe("qmd_new")
    expect(device.identity?.token).toBe("qmd_new")
    await device.disconnect()
  })

  it("stops retrying a credential the platform says can't be renewed", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "credential does not expire" }), { status: 409 })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    const errors: Error[] = []
    const device = newDevice(await seeded(credential))
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(25 * DAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(RenewalError.isError(errors[0])).toBe(true)
    await device.disconnect()
  })

  it("renews a credential already due before connecting", async () => {
    vi.setSystemTime(ISSUED + 25 * DAY_MS)
    vi.stubGlobal("fetch", async () => Promise.resolve(renewedBody("qmd_new", Date.now())))
    const device = newDevice(await seeded(credential))
    await connectWith(device, new FakeMqttClient())

    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({ password: "qmd_new" })
    await device.disconnect()
  })

  it("connects with the old credential when a due renewal fails", async () => {
    vi.setSystemTime(ISSUED + 25 * DAY_MS)
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("fetch failed")))
    const device = newDevice(await seeded(credential))
    device.onError(() => undefined)
    await connectWith(device, new FakeMqttClient())

    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({ password: "qmd_old" })
    await device.disconnect()
  })

  it("refuses to connect with an expired credential", async () => {
    vi.setSystemTime(ISSUED + 31 * DAY_MS)
    const device = newDevice(await seeded(credential))

    await expect(device.connect()).rejects.toBeInstanceOf(CredentialError)
    await expect(device.connect()).rejects.toThrow("claim the device again with a new claim code")
    expect(connect).not.toHaveBeenCalled()
  })

  it("schedules nothing for a credential without an expiry", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { expiresAt: _expiry, ...forever } = credential
    const device = newDevice(await seeded(forever))
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(400 * DAY_MS)
    expect(fetchMock).not.toHaveBeenCalled()
    await device.disconnect()
  })

  it("renews at the API URL the stored credential names", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Promise.resolve(renewedBody("qmd_new", Date.now()))
    )
    vi.stubGlobal("fetch", fetchMock)
    const device = newDevice(await seeded({ ...credential, apiUrl: ZONE_URL }))
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${ZONE_URL}${RENEW_PATH}`])
    expect(device.identity).toMatchObject({ token: "qmd_new", apiUrl: ZONE_URL })
    await device.disconnect()
  })

  it("renews at provisioningUrl while the credential names no API URL", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Promise.resolve(renewedBody("qmd_new", Date.now()))
    )
    vi.stubGlobal("fetch", fetchMock)
    const device = newDevice(await seeded(credential))
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.com${RENEW_PATH}`
    ])
    await device.disconnect()
  })

  it("renews next at the API URL a renewal names", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Promise.resolve(renewedBody("qmd_new", Date.now(), ZONE_URL))
    )
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded(credential)
    const device = newDevice(store)
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)
    expect((await store.load())?.apiUrl).toBe(ZONE_URL)
    await vi.advanceTimersByTimeAsync(20 * DAY_MS)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.example.com${RENEW_PATH}`,
      `${ZONE_URL}${RENEW_PATH}`
    ])
    await device.disconnect()
  })

  it("renews a due credential at its API URL before connecting", async () => {
    vi.setSystemTime(ISSUED + 25 * DAY_MS)
    const fetchMock = vi.fn(async (_url: string) =>
      Promise.resolve(renewedBody("qmd_new", Date.now()))
    )
    vi.stubGlobal("fetch", fetchMock)
    const device = newDevice(await seeded({ ...credential, apiUrl: ZONE_URL }))
    await connectWith(device, new FakeMqttClient())

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${ZONE_URL}${RENEW_PATH}`])
    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({ password: "qmd_new" })
    await device.disconnect()
  })

  it("renews at provisioningUrl when the API URL gives no response, and reports the miss", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(ZONE_URL)
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(renewedBody("qmd_new", Date.now()))
    )
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded({ ...credential, apiUrl: ZONE_URL })
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${ZONE_URL}${RENEW_PATH}`,
      `https://api.example.com${RENEW_PATH}`
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RenewalError)
    expect(errors[0]?.message).toBe(
      `no response from ${ZONE_URL}: provisioningUrl answered instead`
    )
    expect(await store.load()).toMatchObject({ token: "qmd_new", apiUrl: ZONE_URL })
    await device.disconnect()
  })

  it("reports the miss at the API URL only once the renewed credential is saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(ZONE_URL)
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(renewedBody("qmd_new", Date.now()))
      )
    )
    const memory = await seeded({ ...credential, apiUrl: ZONE_URL })
    const events: string[] = []
    const store: CredentialStore = {
      load: async () => memory.load(),
      save: async (saved) => {
        events.push(`saved ${saved.token ?? saved.kind}`)
        await memory.save(saved)
      },
      clear: async () => memory.clear()
    }
    const device = newDevice(store)
    device.onError((error) => {
      events.push(`error ${error.message}`)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(events).toEqual([
      "saved qmd_new",
      `error no response from ${ZONE_URL}: provisioningUrl answered instead`
    ])
    await device.disconnect()
  })

  it("reports a failed save, not the miss, when the renewed credential can't be stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith(ZONE_URL)
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(renewedBody("qmd_new", Date.now()))
      )
    )
    const memory = await seeded({ ...credential, apiUrl: ZONE_URL })
    const store: CredentialStore = {
      load: async () => memory.load(),
      save: async () => Promise.reject(new CredentialError("credential store is full")),
      clear: async () => memory.clear()
    }
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(errors.map((error) => error.message)).toEqual(["credential store is full"])
    expect((await memory.load())?.token).toBe("qmd_old")
    await device.disconnect()
  })

  it("keeps the old credential and reports both misses when neither URL responds", async () => {
    const fetchMock = vi.fn(async (_url: string) => Promise.reject(new TypeError("fetch failed")))
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded({ ...credential, apiUrl: ZONE_URL })
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${ZONE_URL}${RENEW_PATH}`,
      `https://api.example.com${RENEW_PATH}`
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(RenewalError)
    expect(errors[0]?.message).toBe(
      `no response from ${ZONE_URL}, then at provisioningUrl: could not reach the provisioning endpoint to renew the credential: check the network connection`
    )
    expect(errors[0]?.cause).toBeInstanceOf(AggregateError)
    expect((await store.load())?.token).toBe("qmd_old")
    await device.disconnect()
  })

  it("renews at provisioningUrl when the API URL answers with a server error", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(ZONE_URL)
        ? Promise.resolve(
            new Response(JSON.stringify({ message: "origin unreachable" }), { status: 530 })
          )
        : Promise.resolve(renewedBody("qmd_new", Date.now()))
    )
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded({ ...credential, apiUrl: ZONE_URL })
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${ZONE_URL}${RENEW_PATH}`,
      `https://api.example.com${RENEW_PATH}`
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(`${ZONE_URL} answered 530: provisioningUrl answered instead`)
    expect((await store.load())?.token).toBe("qmd_new")
    await device.disconnect()
  })

  it("doesn't try provisioningUrl when the API URL refuses the credential", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Promise.resolve(new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }))
    )
    vi.stubGlobal("fetch", fetchMock)
    const store = await seeded({ ...credential, apiUrl: ZONE_URL })
    const errors: Error[] = []
    const device = newDevice(store)
    device.onError((error) => {
      errors.push(error)
    })
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(20 * DAY_MS + 1)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${ZONE_URL}${RENEW_PATH}`])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ status: 401, message: "unauthorized" })
    expect((await store.load())?.token).toBe("qmd_old")
    await device.disconnect()
  })

  it("re-arms a renewal too far off for one timer", async () => {
    const fetchMock = vi.fn(async () => Promise.resolve(renewedBody("qmd_new", Date.now())))
    vi.stubGlobal("fetch", fetchMock)
    const longLived = { ...credential, expiresAt: new Date(ISSUED + 90 * DAY_MS).toISOString() }
    const device = newDevice(await seeded(longLived))
    await connectWith(device, new FakeMqttClient())

    await vi.advanceTimersByTimeAsync(30 * DAY_MS)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(31 * DAY_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await device.disconnect()
  })
})
