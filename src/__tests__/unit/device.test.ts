import { EventEmitter } from "node:events"

import { connect, type MqttClient } from "mqtt"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Device } from "../../device.js"
import { ConnectionError, CredentialError } from "../../errors.js"
import { createMemoryCredentialStore } from "../../store.js"
import type { CredentialStore, DeviceCredential } from "../../types.js"

vi.mock("mqtt", () => ({ connect: vi.fn() }))

class FakeMqttClient extends EventEmitter {
  publishCalls: { topic: string; message: unknown }[] = []
  subscribeCalls: { topic: string | string[] }[] = []
  ended = false
  publish(topic: string, message: unknown, _opts: unknown, cb: (error?: Error) => void): void {
    this.publishCalls.push({ topic, message })
    cb()
  }
  subscribe(topic: string | string[], _opts: unknown, cb: (error: Error | null) => void): void {
    this.subscribeCalls.push({ topic })
    cb(null)
  }
  end(_force: boolean, _opts: unknown, cb: () => void): void {
    this.ended = true
    cb()
  }
}

const tokenCredential: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "t",
  spaceId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: "2026-01-01T00:00:00.000Z"
}

const seededStore = async (credential: DeviceCredential): Promise<CredentialStore> => {
  const store = createMemoryCredentialStore()
  await store.save(credential)
  return store
}

const newDevice = (store: CredentialStore): Device =>
  new Device({
    provisioningUrl: "https://api.example.com",
    broker: { host: "gw.example.com" },
    store
  })

const connectWith = async (device: Device, client: FakeMqttClient): Promise<void> => {
  vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
  const pending = device.connect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.emit("connect")
  await pending
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("Device construction", () => {
  it("starts idle with no identity", () => {
    const device = newDevice(createMemoryCredentialStore())
    expect(device.connectionState).toBe("idle")
    expect(device.identity).toBeNull()
  })

  it("fails to connect without a stored credential or claim code", async () => {
    await expect(newDevice(createMemoryCredentialStore()).connect()).rejects.toBeInstanceOf(
      CredentialError
    )
  })
})

describe("Device connect (token)", () => {
  let device: Device
  let client: FakeMqttClient

  beforeEach(async () => {
    device = newDevice(await seededStore(tokenCredential))
    client = new FakeMqttClient()
    await connectWith(device, client)
  })

  it("reaches connected and exposes identity", () => {
    expect(device.connectionState).toBe("connected")
    expect(device.identity?.token).toBe("qmd_secret")
    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({ password: "qmd_secret" })
  })

  it("publishes and subscribes", async () => {
    await device.publish("telemetry", "hi")
    await device.subscribe("commands")
    expect(client.publishCalls).toHaveLength(1)
    expect(client.subscribeCalls).toHaveLength(1)
  })

  it("disconnects gracefully", async () => {
    await device.disconnect()
    expect(device.connectionState).toBe("closed")
    expect(client.ended).toBe(true)
  })
})

describe("Device events", () => {
  it("notifies and unsubscribes state listeners; emits messages and errors", async () => {
    const device = newDevice(await seededStore(tokenCredential))
    const client = new FakeMqttClient()
    const states: string[] = []
    const off = device.onState((s) => states.push(s))
    const messages: string[] = []
    device.onMessage((topic) => messages.push(topic))
    const errors: Error[] = []
    device.onError((e) => errors.push(e))

    await connectWith(device, client)
    off()
    client.emit("reconnect")
    client.emit("message", "telemetry", new Uint8Array())
    client.emit("error", new Error("boom"))

    expect(states).toContain("connected")
    expect(device.connectionState).toBe("reconnecting")
    expect(messages).toEqual(["telemetry"])
    expect(errors).toHaveLength(1)
  })
})

describe("Device errors", () => {
  it("rejects publish/subscribe before connect", async () => {
    const device = newDevice(createMemoryCredentialStore())
    await expect(device.publish("t", "x")).rejects.toBeInstanceOf(ConnectionError)
    await expect(device.subscribe("t")).rejects.toBeInstanceOf(ConnectionError)
  })

  it("rejects a cert credential missing key/cert material", async () => {
    const device = newDevice(
      await seededStore({ ...tokenCredential, kind: "cert", token: undefined })
    )
    await expect(device.connect()).rejects.toBeInstanceOf(CredentialError)
  })

  it("wraps a connection error", async () => {
    const device = newDevice(await seededStore(tokenCredential))
    const client = new FakeMqttClient()
    vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
    const pending = device.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.emit("error", new Error("refused"))
    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
  })

  it("connects via the certificate path", async () => {
    const certCredential: DeviceCredential = {
      ...tokenCredential,
      kind: "cert",
      token: undefined,
      privateKeyPem: "KEY",
      certificatePem: "CERT"
    }
    const device = newDevice(await seededStore(certCredential))
    await connectWith(device, new FakeMqttClient())
    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({ key: "KEY", cert: "CERT" })
  })

  it("applies broker overrides and propagates publish/subscribe errors", async () => {
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com", port: 9000, ca: "CA", rejectUnauthorized: false },
      keepaliveSeconds: 30,
      reconnectPeriodMs: 500,
      store: await seededStore(tokenCredential)
    })
    const client = new FakeMqttClient()
    await connectWith(device, client)
    expect(vi.mocked(connect).mock.calls[0]?.[0]).toMatchObject({
      port: 9000,
      ca: "CA",
      rejectUnauthorized: false,
      keepalive: 30,
      reconnectPeriod: 500
    })

    client.publish = (_t, _m, _o, cb): void => {
      cb(new Error("pub"))
    }
    client.subscribe = (_t, _o, cb): void => {
      cb(new Error("sub"))
    }
    await expect(device.publish("t", new Uint8Array([1]))).rejects.toThrow("pub")
    await expect(device.subscribe(["t"])).rejects.toThrow("sub")
  })

  it("claims when no credential is stored, then stays closed after disconnect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { deviceId: "d", spaceId: "s", teamId: "t", secret: "qmd_n" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      claimCode: "qmc_x.y",
      name: "dev",
      store: createMemoryCredentialStore()
    })
    const client = new FakeMqttClient()
    await connectWith(device, client)
    expect(device.identity?.deviceId).toBe("d")

    await device.disconnect()
    client.emit("close")
    expect(device.connectionState).toBe("closed")
  })
})
