import { afterEach, describe, expect, it, vi } from "vitest"

import { ClaimError, ProvisioningError } from "../../errors.js"
import {
  type AccessPointController,
  type HomeNetwork,
  type HomeNetworkController,
  ProvisioningServer,
  type ProvisioningServerOptions
} from "../../provision-server.js"
import { createMemoryCredentialStore } from "../../store.js"
import type { CredentialStore, DeviceCredential } from "../../types.js"

const credential: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "t",
  spaceId: "s",
  kind: "token",
  token: "qmd_secret",
  issuedAt: new Date().toISOString()
}

type Harness = {
  server: ProvisioningServer
  store: CredentialStore
  url: string
  accessPoint: { started: number; stopped: number } & AccessPointController
}

const startServer = async (
  overrides: Partial<ProvisioningServerOptions> = {},
  store: CredentialStore = createMemoryCredentialStore()
): Promise<Harness> => {
  const accessPoint = {
    started: 0,
    stopped: 0,
    start() {
      this.started += 1
    },
    stop() {
      this.stopped += 1
    }
  }
  const server = new ProvisioningServer({
    provisioningUrl: "https://api.example.com",
    store,
    host: "127.0.0.1",
    port: 0,
    deviceName: "field-gateway",
    accessPoint,
    exchange: async () => Promise.resolve(credential),
    ...overrides
  })
  const { port } = await server.start()
  return { server, store, url: `http://127.0.0.1:${String(port)}`, accessPoint }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ProvisioningServer lifecycle", () => {
  it("refuses to start when a credential is already stored", async () => {
    const store = createMemoryCredentialStore()
    await store.save(credential)
    const server = new ProvisioningServer({
      provisioningUrl: "https://api.example.com",
      store,
      host: "127.0.0.1",
      port: 0
    })

    await expect(server.start()).rejects.toBeInstanceOf(ProvisioningError)
    expect(server.state).toBe("idle")
  })

  it("refuses to start twice", async () => {
    const { server } = await startServer()
    await expect(server.start()).rejects.toBeInstanceOf(ProvisioningError)
    await server.stop()
  })

  it("stops cleanly and can restart onboarding", async () => {
    const { server, accessPoint } = await startServer()
    expect(server.state).toBe("serving")
    expect(accessPoint.started).toBe(1)

    await server.stop()
    expect(server.state).toBe("closed")
    expect(accessPoint.stopped).toBe(1)

    await server.stop() // idempotent
    const { port } = await server.start()
    expect(server.state).toBe("serving")
    expect(port).toBeGreaterThan(0)
    await server.stop()
  })

  it("fails to start when the access point fails, without listening", async () => {
    const server = new ProvisioningServer({
      provisioningUrl: "https://api.example.com",
      store: createMemoryCredentialStore(),
      host: "127.0.0.1",
      port: 0,
      accessPoint: {
        start: () => {
          throw new Error("hostapd missing")
        },
        stop: () => undefined
      }
    })

    await expect(server.start()).rejects.toBeInstanceOf(ProvisioningError)
    expect(server.state).toBe("idle")
  })
})

describe("GET /provision/info", () => {
  it("advertises an awaiting-claim device with its name", async () => {
    const { server, url } = await startServer()

    const response = await fetch(`${url}/provision/info`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "awaiting-claim", name: "field-gateway" })
    await server.stop()
  })

  it("omits the name when none is configured", async () => {
    const { server, url } = await startServer({ deviceName: undefined })

    const response = await fetch(`${url}/provision/info`)
    expect(await response.json()).toEqual({ status: "awaiting-claim" })
    await server.stop()
  })

  it("rejects other methods and unknown paths", async () => {
    const { server, url } = await startServer()

    const wrongMethod = await fetch(`${url}/provision/info`, { method: "POST" })
    expect(wrongMethod.status).toBe(405)

    const unknown = await fetch(`${url}/nope`)
    expect(unknown.status).toBe(404)
    await server.stop()
  })
})

describe("POST /provision/claim", () => {
  it("claims, persists, and stops serving before onProvisioned runs", async () => {
    let onProvisioned!: (credential: DeviceCredential) => void
    const provisioned = new Promise<DeviceCredential>((resolve) => {
      onProvisioned = resolve
    })
    const { server, store, url, accessPoint } = await startServer({
      onProvisioned: (credential) => {
        onProvisioned(credential)
      }
    })

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "qmc_x.y", name: "kitchen" })
    })

    expect(response.status).toBe(200)
    const identity = (await response.json()) as Record<string, unknown>
    expect(identity).toEqual({ deviceId: credential.deviceId, teamId: "t", spaceId: "s" })
    expect(identity.token).toBeUndefined()

    const handedOff = await provisioned
    expect(handedOff.token).toBe("qmd_secret")
    expect((await store.load())?.deviceId).toBe(credential.deviceId)
    expect(server.state).toBe("provisioned")
    expect(accessPoint.stopped).toBe(1)

    // The claim endpoint is gone once provisioned.
    await expect(fetch(`${url}/provision/info`)).rejects.toThrow()
    await expect(server.start()).rejects.toBeInstanceOf(ProvisioningError)
  })

  it("forwards the claim code and name to the exchange", async () => {
    const exchange = vi.fn(async () => Promise.resolve(credential))
    const { server, url } = await startServer({ exchange })

    await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", name: "kitchen" })
    })

    expect(exchange).toHaveBeenCalledWith({ code: "qmc_x.y", name: "kitchen" })
    await server.stop()
  })

  it("rejects malformed bodies with 400 and keeps serving", async () => {
    const { server, url } = await startServer()

    for (const body of ["not json", "{}", JSON.stringify({ code: "" }), "[1]"]) {
      const response = await fetch(`${url}/provision/claim`, { method: "POST", body })
      expect(response.status).toBe(400)
    }
    expect(server.state).toBe("serving")
    await server.stop()
  })

  it("maps a rejected claim to its status and allows a clean retry", async () => {
    let attempt = 0
    const exchange = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return Promise.reject(new ClaimError("Claim code expired", { status: 401 }))
      }
      return Promise.resolve(credential)
    })
    const { server, store, url } = await startServer({ exchange })

    const failed = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_bad" })
    })
    expect(failed.status).toBe(401)
    expect((await failed.json()) as { message: string }).toEqual({
      message: "Claim code expired"
    })
    expect(server.state).toBe("serving")
    expect(await store.load()).toBeNull()

    const retried = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_good" })
    })
    expect(retried.status).toBe(200)
    expect((await store.load())?.token).toBe("qmd_secret")
    await server.stop()
  })

  it("maps an unreachable platform to 502", async () => {
    const exchange = async (): Promise<DeviceCredential> =>
      Promise.reject(new ClaimError("Failed to reach the provisioning endpoint"))
    const { server, url } = await startServer({ exchange })

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y" })
    })
    expect(response.status).toBe(502)
    expect(server.state).toBe("serving")
    await server.stop()
  })

  it("maps an unexpected exchange failure to 502", async () => {
    const exchange = async (): Promise<DeviceCredential> => Promise.reject(new Error("boom"))
    const { server, url } = await startServer({ exchange })

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y" })
    })
    expect(response.status).toBe(502)
    expect((await response.json()) as { message: string }).toEqual({
      message: "The provisioning endpoint failed"
    })
    await server.stop()
  })

  it("reports a persistence failure and keeps serving", async () => {
    const store = createMemoryCredentialStore()
    const failingStore: CredentialStore = {
      ...store,
      save: async () => Promise.reject(new Error("disk full"))
    }
    const { server, url } = await startServer({}, failingStore)

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y" })
    })
    expect(response.status).toBe(500)
    expect(server.state).toBe("serving")
    expect(await store.load()).toBeNull()
    await server.stop()
  })
})

describe("ProvisioningServer home network onboarding", () => {
  const network = { ssid: "home", passphrase: "hunter22" }

  const homeNetworkFake = (
    order: string[],
    joinError?: Error
  ): HomeNetworkController & { joined: HomeNetwork[]; forgotten: number } => ({
    joined: [],
    forgotten: 0,
    join(details) {
      order.push("join")
      this.joined.push(details)
      if (joinError !== undefined) {
        throw joinError
      }
    },
    forget() {
      order.push("forget")
      this.forgotten += 1
    }
  })

  const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(check()).toBe(true)
  }

  it("answers 202 without the identity, then joins and claims after the access point is down", async () => {
    const order: string[] = []
    const homeNetwork = homeNetworkFake(order)
    const exchange = vi.fn(async () => {
      order.push("claim")
      return Promise.resolve(credential)
    })
    let provisioned = false
    const { server, store, url } = await startServer({
      homeNetwork,
      exchange,
      accessPoint: {
        start() {
          order.push("ap-start")
        },
        stop() {
          order.push("ap-stop")
        }
      },
      onProvisioned: () => {
        provisioned = true
      }
    })

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", name: "kitchen", ...network })
    })
    expect(response.status).toBe(202)
    expect((await response.json()) as Record<string, unknown>).toEqual({ status: "joining" })

    await waitFor(() => provisioned)
    expect(order).toEqual(["ap-start", "ap-stop", "join", "claim"])
    expect(homeNetwork.joined).toEqual([network])
    expect(exchange).toHaveBeenCalledWith({ code: "qmc_x.y", name: "kitchen" })
    expect((await store.load())?.token).toBe("qmd_secret")
    expect(server.state).toBe("provisioned")
    await expect(fetch(`${url}/provision/info`)).rejects.toThrow()
  })

  it("forgets the network and brings the access point back when the join fails", async () => {
    const order: string[] = []
    const homeNetwork = homeNetworkFake(order, new Error("wrong passphrase"))
    const exchange = vi.fn(async () => Promise.resolve(credential))
    const errors: Error[] = []
    const { server, store, url, accessPoint } = await startServer({
      homeNetwork,
      exchange,
      onError: (error) => errors.push(error)
    })

    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", ...network })
    })
    expect(response.status).toBe(202)

    await waitFor(() => server.state === "serving")
    expect(order).toEqual(["join", "forget"])
    expect(exchange).not.toHaveBeenCalled()
    expect(accessPoint.stopped).toBe(1)
    expect(accessPoint.started).toBe(2)
    expect(await store.load()).toBeNull()
    expect(errors[0]).toBeInstanceOf(ProvisioningError)
    expect((errors[0] as Error & { cause?: Error }).cause?.message).toBe("wrong passphrase")
    await server.stop()
  })

  it("forgets the network and restarts onboarding when the claim fails", async () => {
    const order: string[] = []
    const homeNetwork = homeNetworkFake(order)
    const exchange = async (): Promise<DeviceCredential> =>
      Promise.reject(new ClaimError("Claim code expired", { status: 401 }))
    const { server, store, url } = await startServer({ homeNetwork, exchange })

    await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", ...network })
    })

    await waitFor(() => server.state === "serving")
    expect(order).toEqual(["join", "forget"])
    expect(await store.load()).toBeNull()

    // Onboarding restarts cleanly on the new listener.
    const { port } = server.boundAddress ?? { port: 0 }
    const info = await fetch(`http://127.0.0.1:${String(port)}/provision/info`)
    expect(info.status).toBe(200)
    await server.stop()
  })

  it("reports a failing onProvisioned without undoing the claim", async () => {
    const homeNetwork = homeNetworkFake([])
    const errors: Error[] = []
    const { server, store, url } = await startServer({
      homeNetwork,
      onProvisioned: () => {
        throw new Error("connect failed")
      },
      onError: (error) => errors.push(error)
    })

    await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", ...network })
    })

    await waitFor(() => errors.length > 0)
    expect(errors[0]?.message).toBe("connect failed")
    expect(server.state).toBe("provisioned")
    expect((await store.load())?.token).toBe("qmd_secret")
    expect(homeNetwork.forgotten).toBe(0)
  })

  it("still restarts onboarding when forgetting the network or restarting fails", async () => {
    const homeNetwork = {
      ...homeNetworkFake([], new Error("network not found")),
      forget() {
        throw new Error("forget failed")
      }
    }
    let starts = 0
    const errors: Error[] = []
    const { server, url } = await startServer({
      homeNetwork,
      accessPoint: {
        start() {
          starts += 1
          if (starts > 1) {
            throw new Error("radio busy")
          }
        },
        stop: vi.fn()
      },
      onError: (error) => errors.push(error)
    })

    await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", ...network })
    })

    await waitFor(() => errors.length >= 3)
    expect(errors.map((error) => error.message)).toEqual([
      "Onboarding failed; bringing the setup access point back",
      "forget failed",
      "Failed to start the setup access point"
    ])
    expect(server.state).toBe("idle")
  })

  it("refuses Wi-Fi details when the deployment can't join a network", async () => {
    const { server, url } = await startServer()
    const response = await fetch(`${url}/provision/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "qmc_x.y", ...network })
    })
    expect(response.status).toBe(501)
    expect(server.state).toBe("serving")
    await server.stop()
  })

  it("rejects half the Wi-Fi details with 400", async () => {
    const { server, url } = await startServer({ homeNetwork: homeNetworkFake([]) })
    for (const extra of [{ ssid: "home" }, { passphrase: "x" }, { ssid: "", passphrase: "x" }]) {
      const response = await fetch(`${url}/provision/claim`, {
        method: "POST",
        body: JSON.stringify({ code: "qmc_x.y", ...extra })
      })
      expect(response.status).toBe(400)
    }
    expect(server.state).toBe("serving")
    await server.stop()
  })
})
