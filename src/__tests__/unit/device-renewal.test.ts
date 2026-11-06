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

const credential: DeviceCredential = {
  deviceId: "dev_1",
  teamId: "t",
  scopeId: "s",
  kind: "token",
  token: "qmd_old",
  issuedAt: new Date(ISSUED).toISOString(),
  expiresAt: new Date(ISSUED + 30 * DAY_MS).toISOString()
}

const renewedBody = (secret: string, now: number): Response =>
  new Response(
    JSON.stringify({
      data: { secret, credential: { expiresAt: new Date(now + 30 * DAY_MS).toISOString() } }
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
