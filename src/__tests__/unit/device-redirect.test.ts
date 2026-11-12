import { EventEmitter } from "node:events"

import { connect, type MqttClient } from "mqtt"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Device, parseServerReference } from "../../device.js"
import { ConnectionError } from "../../errors.js"
import { createMemoryCredentialStore } from "../../store.js"
import type { CredentialStore, DeviceCredential } from "../../types.js"

vi.mock("mqtt", () => ({ connect: vi.fn() }))

class FakeMqttClient extends EventEmitter {
  options: { host?: string; hostname?: string; servername?: string; port?: number } = {}
  ended = false
  publish(_topic: string, _message: unknown, _opts: unknown, cb: (error?: Error) => void): void {
    cb()
  }
  subscribe(_topic: string, _opts: unknown, cb: (error: Error | null) => void): void {
    cb(null)
  }
  end(_force?: boolean, _opts?: unknown, cb?: () => void): void {
    this.ended = true
    cb?.()
  }
}

const credential: DeviceCredential = {
  deviceId: "dev_01JAYQ4T7Z9K3M5N8P2R6S0V1W",
  teamId: "t",
  scopeId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: "2026-01-01T00:00:00.000Z",
  broker: { host: "gw.test-sg-sin-a.example.com", port: 8883 }
}

const seededStore = async (): Promise<CredentialStore> => {
  const store = createMemoryCredentialStore()
  await store.save(credential)
  return store
}

const newDevice = (store: CredentialStore): Device =>
  new Device({
    capabilities: [{ key: "power", type: "onoff" }],
    provisioningUrl: "https://api.example.com",
    store
  })

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Hand out each client in turn, with the options the device built for it. */
const queueClients = (...clients: FakeMqttClient[]): void => {
  for (const client of clients) {
    vi.mocked(connect).mockImplementationOnce((opts) => {
      Object.assign(client.options, opts)
      return client as unknown as MqttClient
    })
  }
}

const moved = (serverReference: string, reasonCode = 0x9d): Record<string, unknown> => ({
  cmd: "connack",
  reasonCode,
  properties: { serverReference }
})

/** Refuse a connect the way mqtt.js does: the packet first, then the error. */
const refuse = (client: FakeMqttClient, packet: Record<string, unknown>): void => {
  client.emit("packetreceive", packet)
  client.emit("error", new Error("Connection refused: Server moved"))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("parseServerReference", () => {
  it.each([
    ["gw.home.example.com:8884", { host: "gw.home.example.com", port: 8884 }],
    ["gw.home.example.com", { host: "gw.home.example.com", port: 8883 }],
    ["gw.a.example.com:8885 gw.b.example.com:8886", { host: "gw.a.example.com", port: 8885 }],
    ["[2001:db8::1]:8884", { host: "2001:db8::1", port: 8884 }],
    ["  gw.home.example.com  ", { host: "gw.home.example.com", port: 8883 }]
  ])("reads %s", (reference, expected) => {
    expect(parseServerReference(reference, 8883)).toEqual(expected)
  })

  it.each(["", "   ", "gw.example.com:0", "gw.example.com:70000", "a:b:c", "[]:8883"])(
    "names no gateway for %j",
    (reference) => {
      expect(parseServerReference(reference, 8883)).toBeUndefined()
    }
  )
})

describe("Device redirect", () => {
  it("follows a redirect on the first connect and stores the home gateway", async () => {
    const store = await seededStore()
    const device = newDevice(store)
    const refused = new FakeMqttClient()
    const home = new FakeMqttClient()
    queueClients(refused, home)

    const pending = device.connect()
    await tick()
    refuse(refused, moved("gw.test-de-fra-a.example.com:8884"))
    await tick()
    await tick()
    home.emit("connect", { properties: {} })
    await pending

    expect(refused.ended).toBe(true)
    expect(vi.mocked(connect).mock.calls[1]?.[0]).toMatchObject({
      host: "gw.test-de-fra-a.example.com",
      port: 8884
    })
    expect(device.connectionState).toBe("connected")
    expect((await store.load())?.broker).toEqual({
      host: "gw.test-de-fra-a.example.com",
      port: 8884
    })
  })

  it("follows 0x9C Use another server the same way", async () => {
    const store = await seededStore()
    const device = newDevice(store)
    const refused = new FakeMqttClient()
    const home = new FakeMqttClient()
    queueClients(refused, home)

    const pending = device.connect()
    await tick()
    refuse(refused, moved("gw.other.example.com", 0x9c))
    await tick()
    await tick()
    home.emit("connect", { properties: {} })
    await pending

    expect(vi.mocked(connect).mock.calls[1]?.[0]).toMatchObject({
      host: "gw.other.example.com",
      port: 8883
    })
  })

  it("outranks a configured host after a redirect", async () => {
    const store = await seededStore()
    const device = new Device({
      capabilities: [{ key: "power", type: "onoff" }],
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.configured.example.com" },
      store
    })
    const refused = new FakeMqttClient()
    const home = new FakeMqttClient()
    queueClients(refused, home)

    const pending = device.connect()
    await tick()
    expect(refused.options.host).toBe("gw.configured.example.com")
    refuse(refused, moved("gw.home.example.com:8884"))
    await tick()
    await tick()
    home.emit("connect", { properties: {} })
    await pending

    expect(home.options.host).toBe("gw.home.example.com")
  })

  it("gives up after a bounded number of redirects", async () => {
    const device = newDevice(await seededStore())
    const clients = [0, 1, 2, 3].map(() => new FakeMqttClient())
    queueClients(...clients)

    const outcome = expect(device.connect()).rejects.toBeInstanceOf(ConnectionError)
    for (const client of clients) {
      await tick()
      refuse(client, moved(`gw.hop-${String(clients.indexOf(client))}.example.com`))
      await tick()
    }

    await outcome
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(4)
    expect(device.connectionState).toBe("idle")
  })

  it("repoints an established session's reconnects at the home gateway", async () => {
    const store = await seededStore()
    const device = newDevice(store)
    const client = new FakeMqttClient()
    queueClients(client)
    const pending = device.connect()
    await tick()
    client.emit("connect", { properties: {} })
    await pending

    client.emit("packetreceive", moved("gw.home.example.com:8884"))
    await tick()

    expect(client.options).toMatchObject({
      host: "gw.home.example.com",
      hostname: "gw.home.example.com",
      servername: "gw.home.example.com",
      port: 8884
    })
    expect((await store.load())?.broker).toEqual({ host: "gw.home.example.com", port: 8884 })
  })

  it("ignores a refusal that names no gateway", async () => {
    const store = await seededStore()
    const device = newDevice(store)
    const client = new FakeMqttClient()
    queueClients(client)
    const pending = device.connect()
    await tick()
    client.emit("packetreceive", { cmd: "connack", reasonCode: 0x87 })
    client.emit("packetreceive", { cmd: "connack", reasonCode: 0x9d })
    client.emit("packetreceive", { cmd: "connack", reasonCode: 0x9d, properties: {} })
    client.emit("packetreceive", {
      cmd: "connack",
      reasonCode: 0x9d,
      properties: { serverReference: ":" }
    })
    client.emit("packetreceive", { cmd: "publish", reasonCode: 0x9d })
    client.emit("packetreceive", null)
    client.emit("error", new Error("Connection refused: Not authorized"))

    await expect(pending).rejects.toBeInstanceOf(ConnectionError)
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1)
    expect((await store.load())?.broker).toEqual(credential.broker)
  })

  it("reports a failed save and still follows the redirect", async () => {
    const store = await seededStore()
    const saveError = new Error("disk full")
    vi.spyOn(store, "save").mockRejectedValueOnce(saveError)
    const device = newDevice(store)
    const errors: Error[] = []
    device.onError((error) => errors.push(error))
    const refused = new FakeMqttClient()
    const home = new FakeMqttClient()
    queueClients(refused, home)

    const pending = device.connect()
    await tick()
    refuse(refused, moved("gw.home.example.com:8884"))
    await tick()
    await tick()
    home.emit("connect", { properties: {} })
    await pending

    expect(errors).toContain(saveError)
    expect(home.options.host).toBe("gw.home.example.com")
  })
})
