import { EventEmitter } from "node:events"

import { connect, type MqttClient } from "mqtt"
import { afterEach, describe, expect, it, vi } from "vitest"

import { claimCommand, connectCommand, provisionCommand } from "../../../cli/commands.js"
import { Device } from "../../../device.js"
import { CredentialError } from "../../../errors.js"
import { createMemoryCredentialStore } from "../../../store.js"
import type { CredentialStore, DeviceCredential } from "../../../types.js"

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

const tokenCredential: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "t",
  spaceId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: "2026-01-01T00:00:00.000Z"
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("claimCommand", () => {
  it("claims and persists a credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { deviceId: "d", spaceId: "s", teamId: "t", secret: "qmd_x" }
      })
    )
    const store = createMemoryCredentialStore()

    const credential = await claimCommand({
      code: "qmc_x.y",
      provisioningUrl: "https://api.example.com",
      store
    })

    expect(credential.deviceId).toBe("d")
    expect(await store.load()).toEqual(credential)
  })
})

describe("provisionCommand", () => {
  it("throws CredentialError when nothing is stored yet", async () => {
    await expect(
      provisionCommand({
        provisioningUrl: "https://api.example.com",
        store: createMemoryCredentialStore()
      })
    ).rejects.toBeInstanceOf(CredentialError)
  })

  it("enrolls a cert credential from the stored token credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { certificatePem: "cert-pem", caCertificatePem: "ca-pem" }
      })
    )
    const store: CredentialStore = createMemoryCredentialStore()
    await store.save(tokenCredential)

    const credential = await provisionCommand({
      provisioningUrl: "https://api.example.com",
      store,
      label: "primary"
    })

    expect(credential.kind).toBe("cert")
    expect(await store.load()).toEqual(credential)
  })
})

describe("connectCommand", () => {
  it("connects, publishes, and reports the result", async () => {
    const store = createMemoryCredentialStore()
    await store.save(tokenCredential)
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      store
    })

    const client = new FakeMqttClient()
    vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
    const pending = connectCommand({
      device,
      publish: { topic: "telemetry/temperature", payload: "21.4" }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.emit("connect")
    const result = await pending

    expect(result.identity.deviceId).toBe(tokenCredential.deviceId)
    expect(result.published).toEqual({ topic: "telemetry/temperature", payload: "21.4" })
    expect(client.publishCalls).toEqual([{ topic: "telemetry/temperature", message: "21.4" }])
  })

  it("subscribes and forwards inbound messages", async () => {
    const store = createMemoryCredentialStore()
    await store.save(tokenCredential)
    const device = new Device({
      provisioningUrl: "https://api.example.com",
      broker: { host: "gw.example.com" },
      store
    })

    const client = new FakeMqttClient()
    vi.mocked(connect).mockReturnValue(client as unknown as MqttClient)
    const received: { topic: string; payload: Uint8Array }[] = []
    const pending = connectCommand({
      device,
      subscribeTopics: ["commands/#"],
      onMessage: (topic, payload) => {
        received.push({ topic, payload })
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.emit("connect")
    const result = await pending

    expect(result.subscribed).toEqual(["commands/#"])
    expect(client.subscribeCalls).toEqual([{ topic: ["commands/#"] }])

    client.emit("message", "commands/reboot", Buffer.from("now"))
    expect(received).toEqual([{ topic: "commands/reboot", payload: Buffer.from("now") }])
  })

  it("throws CredentialError if the device has no identity after connecting", async () => {
    const fakeDevice = {
      connect: async () => Promise.resolve(),
      identity: null
    } as unknown as Device

    await expect(connectCommand({ device: fakeDevice })).rejects.toBeInstanceOf(CredentialError)
  })
})
