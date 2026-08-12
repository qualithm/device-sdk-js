import { EventEmitter } from "node:events"

import { connect, type MqttClient } from "mqtt"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Device } from "../../device.js"
import { CapabilityError, CommandError } from "../../errors.js"
import { createMemoryCredentialStore } from "../../store.js"
import type { CredentialStore, DeviceCredential, DeviceOptions } from "../../types.js"

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

const newDevice = async (
  options: Partial<DeviceOptions> = {}
): Promise<{ device: Device; client: FakeMqttClient }> => {
  const device = new Device({
    provisioningUrl: "https://api.example.com",
    broker: { host: "gw.example.com" },
    store: await seededStore(tokenCredential),
    ...options
  })
  const client = new FakeMqttClient()
  vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
  const pending = device.connect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.emit("connect")
  await pending
  return { device, client }
}

const sendCommand = (client: FakeMqttClient, key: string, payload: string): void => {
  client.emit("message", `command/${key}`, new TextEncoder().encode(payload))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("capability manifest", () => {
  it("publishes the declared manifest to the reserved topic on connect", async () => {
    const { client } = await newDevice({
      capabilities: [
        { key: "power", type: "onoff" },
        { key: "reboot", type: "trigger" }
      ]
    })
    const manifest = client.publishCalls.find((call) => call.topic === "capabilities")
    expect(JSON.parse(String(manifest?.message))).toEqual({
      capabilities: [
        { key: "power", type: "onoff", config: {} },
        { key: "reboot", type: "trigger", config: {} }
      ]
    })
  })

  it("re-publishes the manifest on reconnect", async () => {
    const { client } = await newDevice({ capabilities: [{ key: "power", type: "onoff" }] })
    expect(client.publishCalls).toHaveLength(1)
    client.emit("connect")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.publishCalls.filter((call) => call.topic === "capabilities")).toHaveLength(2)
  })

  it("publishes nothing on connect when no capabilities are declared", async () => {
    const { client } = await newDevice()
    expect(client.publishCalls).toHaveLength(0)
  })

  it("rejects an invalid declaration at construction and at declaration time", async () => {
    const store = await seededStore(tokenCredential)
    expect(
      () =>
        new Device({
          provisioningUrl: "https://api.example.com",
          broker: { host: "gw.example.com" },
          store,
          capabilities: [{ key: "bad key", type: "onoff" }]
        })
    ).toThrow(CapabilityError)

    const { device } = await newDevice()
    await expect(
      device.declareCapabilities([{ key: "r", type: "range", min: 1, max: 0 }])
    ).rejects.toBeInstanceOf(CapabilityError)
  })

  it("publishes immediately when declareCapabilities is called on a live session", async () => {
    const { device, client } = await newDevice()
    await device.declareCapabilities([{ key: "power", type: "onoff" }])
    expect(client.publishCalls.map((call) => call.topic)).toEqual(["capabilities"])
  })
})

describe("command dispatch", () => {
  it("subscribes command/# once handlers are registered, exactly once", async () => {
    const store = await seededStore(tokenCredential)
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      store
    })
    device.onCommand("power", () => undefined)
    const client = new FakeMqttClient()
    vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
    const pending = device.connect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.emit("connect")
    await pending

    device.onCommand("reboot", () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.subscribeCalls).toEqual([{ topic: "command/#" }])
  })

  it("does not subscribe command/# without a registered handler", async () => {
    const { client } = await newDevice()
    expect(client.subscribeCalls).toHaveLength(0)
  })

  it("routes a command to its handler with the decoded value, not a raw buffer", async () => {
    const { device, client } = await newDevice()
    const received: unknown[] = []
    device.onCommand<boolean>("power", (value) => {
      received.push(value)
    })
    sendCommand(client, "power", '{"value":true}')
    expect(received).toEqual([true])
  })

  it("matches the Decision #241 payload shapes for every commandable type", async () => {
    const { device, client } = await newDevice()
    const received: unknown[] = []
    device.onCommand<boolean>("power", (value) => received.push(value))
    device.onCommand<number>("brightness", (value) => received.push(value))
    device.onCommand<string>("mode", (value) => received.push(value))
    device.onCommand("reboot", (value) => received.push(value))

    sendCommand(client, "power", '{"value":true}')
    sendCommand(client, "brightness", '{"value":0.5}')
    sendCommand(client, "mode", '{"value":"auto"}')
    sendCommand(client, "reboot", "{}")
    expect(received).toEqual([true, 0.5, "auto", undefined])
  })

  it("rejects a malformed payload through onError without killing the handler loop", async () => {
    const { device, client } = await newDevice()
    const received: unknown[] = []
    const errors: Error[] = []
    device.onCommand<boolean>("power", (value) => {
      received.push(value)
    })
    device.onError((error) => {
      errors.push(error)
    })

    sendCommand(client, "power", "not json")
    sendCommand(client, "power", '{"other":1}')
    sendCommand(client, "power", '{"value":false}')
    expect(errors).toHaveLength(2)
    expect(errors.every((error) => CommandError.isError(error))).toBe(true)
    expect(received).toEqual([false])
  })

  it("ignores a command for an unregistered key", async () => {
    const { device, client } = await newDevice()
    const errors: Error[] = []
    device.onError((error) => {
      errors.push(error)
    })
    device.onCommand("power", () => undefined)
    sendCommand(client, "unknown", '{"value":true}')
    expect(errors).toHaveLength(0)
  })

  it("rejects a value that does not fit the declared capability type", async () => {
    const { device, client } = await newDevice({
      capabilities: [{ key: "power", type: "onoff" }]
    })
    const received: unknown[] = []
    const errors: Error[] = []
    device.onCommand<boolean>("power", (value) => {
      received.push(value)
    })
    device.onError((error) => {
      errors.push(error)
    })

    sendCommand(client, "power", '{"value":1}')
    sendCommand(client, "power", '{"value":true}')
    expect(errors).toHaveLength(1)
    expect(CommandError.isError(errors[0])).toBe(true)
    expect(received).toEqual([true])
  })

  it("refuses to register a handler for a read-only sensor or an invalid key", async () => {
    const { device } = await newDevice({
      capabilities: [{ key: "temp", type: "sensor", metric: "temperature_c" }]
    })
    expect(() => device.onCommand("temp", () => undefined)).toThrow(CapabilityError)
    expect(() => device.onCommand("bad key", () => undefined)).toThrow(CapabilityError)
  })

  it("stops dispatching after the handler is unregistered, and reports a throwing handler", async () => {
    const { device, client } = await newDevice()
    const received: unknown[] = []
    const errors: Error[] = []
    device.onError((error) => {
      errors.push(error)
    })
    const off = device.onCommand<boolean>("power", (value) => {
      received.push(value)
    })

    sendCommand(client, "power", '{"value":true}')
    off()
    sendCommand(client, "power", '{"value":false}')
    expect(received).toEqual([true])

    device.onCommand("reboot", () => {
      throw new Error("handler boom")
    })
    sendCommand(client, "reboot", "{}")
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe("handler boom")
  })
})
