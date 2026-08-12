/**
 * Soft-AP provisioning server: the device-side endpoint the companion app
 * talks to on the device's setup network (Decision #280).
 *
 * When the device has no credential, the server advertises itself at
 * `GET /provision/info` and accepts the claim exchange at
 * `POST /provision/claim`, persisting the resulting credential to the
 * device's {@link CredentialStore}. A successful claim stops the server and
 * the setup access point before {@link ProvisioningServerOptions.onProvisioned}
 * runs, so the claim endpoint is never served alongside a gateway session. A
 * failed claim leaves the server running, so onboarding can restart cleanly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { claimDevice, type ClaimRequest } from "./claim.js"
import { ClaimError, ProvisioningError } from "./errors.js"
import type { CredentialStore, DeviceCredential } from "./types.js"

const INFO_PATH = "/provision/info"
const CLAIM_PATH = "/provision/claim"
const MAX_BODY_BYTES = 16 * 1024

/** Lifecycle state of a {@link ProvisioningServer}. */
export type ProvisioningServerState = "idle" | "serving" | "provisioned" | "closed"

/**
 * Deployment-supplied control over the OS-level setup access point
 * (hostapd, NetworkManager, …). The server starts it before listening and
 * stops it on shutdown, so the AP's lifetime always matches the claim
 * endpoint's.
 */
export type AccessPointController = {
  /** Bring up the setup access point. */
  start: () => void | Promise<void>
  /** Tear the setup access point down. */
  stop: () => void | Promise<void>
}

/** Body of `GET /provision/info` while the server awaits a claim. */
export type ProvisioningInfo = {
  /** Always `"awaiting-claim"` — a provisioned device no longer serves. */
  status: "awaiting-claim"
  /** Human-friendly device name, when one was configured. */
  name?: string
}

/** Identity returned to the companion app after a successful claim. */
export type ProvisionedIdentity = {
  /** The device's stable identity (a UUID). */
  deviceId: string
  /** The owning team (tenant boundary). */
  teamId: string
  /** The space the device belongs to. */
  spaceId: string
}

/**
 * Exchanges a claim code for a credential. Defaults to {@link claimDevice}
 * against {@link ProvisioningServerOptions.provisioningUrl}; inject a fake in
 * tests.
 */
export type ClaimExchange = (request: ClaimRequest) => Promise<DeviceCredential>

/** Options for constructing a {@link ProvisioningServer}. */
export type ProvisioningServerOptions = {
  /** Provisioning API base URL, e.g. `https://api.qualithm.com`. */
  provisioningUrl: string
  /** Where the claimed credential is persisted. */
  store: CredentialStore
  /** Human-friendly device name advertised by `GET /provision/info`. */
  deviceName?: string
  /** Interface to listen on. Defaults to `"0.0.0.0"` (the setup network). */
  host?: string
  /** Port to listen on. Defaults to `80`; pass `0` for an ephemeral port. */
  port?: number
  /** Setup access point lifecycle hook, supplied by the deployment. */
  accessPoint?: AccessPointController
  /** Claim exchange override. Defaults to {@link claimDevice}. */
  exchange?: ClaimExchange
  /**
   * Called after a successful claim has been persisted and the server and
   * access point have stopped. This is where the deployment proceeds to
   * `Device.connect()`.
   */
  onProvisioned?: (credential: DeviceCredential) => void | Promise<void>
  /** Called when the post-claim teardown or `onProvisioned` itself fails. */
  onError?: (error: Error) => void
}

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 80

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", connection: "close" })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    size += part.length
    if (size > MAX_BODY_BYTES) {
      throw new ProvisioningError("Request body too large")
    }
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

/**
 * Parse and validate a claim request body. Returns the claim request, or
 * `null` when the body is not a JSON object with a non-empty string `code`.
 */
const parseClaimRequest = (raw: Buffer): ClaimRequest | null => {
  let body: unknown
  try {
    body = JSON.parse(raw.toString("utf8"))
  } catch {
    return null
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null
  }
  const { code, name } = body as Record<string, unknown>
  if (typeof code !== "string" || code === "") {
    return null
  }
  if (name !== undefined && typeof name !== "string") {
    return null
  }
  return { code, ...(name !== undefined && { name }) }
}

/**
 * The device-side soft-AP provisioning server.
 *
 * Serves the claim exchange on the device's setup network while no credential
 * is stored, and only then: construction with an already-populated store
 * fails at {@link ProvisioningServer.start}, and a successful claim stops the
 * server before {@link Device.connect} opens the gateway session.
 *
 * @example
 * ```ts
 * const server = new ProvisioningServer({
 *   provisioningUrl: "https://api.qualithm.com",
 *   store,
 *   deviceName: "field-gateway",
 *   onProvisioned: () => device.connect()
 * })
 * await server.start()
 * ```
 */
export class ProvisioningServer {
  private readonly options: ProvisioningServerOptions
  private readonly exchange: ClaimExchange
  private server: Server | null = null
  private bound: { host: string; port: number } | null = null
  private accessPointStarted = false
  private serverState: ProvisioningServerState = "idle"

  constructor(options: ProvisioningServerOptions) {
    this.options = options
    this.exchange =
      options.exchange ?? (async (request) => claimDevice(options.provisioningUrl, request))
  }

  /** The current lifecycle state. */
  get state(): ProvisioningServerState {
    return this.serverState
  }

  /** The bound listening address once started, otherwise `null`. */
  get boundAddress(): { host: string; port: number } | null {
    return this.bound
  }

  /**
   * Bring up the setup access point (when a controller is supplied) and start
   * serving the claim endpoint. Resolves with the bound address.
   *
   * @throws {@link ProvisioningError} when the device is already provisioned,
   * the server is already running, or the access point or listener fails to
   * start.
   */
  async start(): Promise<{ host: string; port: number }> {
    if (this.serverState === "serving") {
      throw new ProvisioningError("The provisioning server is already running")
    }
    if (this.serverState === "provisioned") {
      throw new ProvisioningError("The device is already provisioned")
    }
    if ((await this.options.store.load()) !== null) {
      throw new ProvisioningError("The device is already provisioned")
    }

    try {
      await this.options.accessPoint?.start()
    } catch (error) {
      throw new ProvisioningError("Failed to start the setup access point", { cause: error })
    }
    this.accessPointStarted = this.options.accessPoint !== undefined

    const host = this.options.host ?? DEFAULT_HOST
    const port = this.options.port ?? DEFAULT_PORT
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, resolve)
      })
    } catch (error) {
      await this.stopAccessPoint()
      throw new ProvisioningError("Failed to start the provisioning server", { cause: error })
    }
    this.server = server
    this.serverState = "serving"

    const address = server.address()
    const boundPort = typeof address === "object" && address !== null ? address.port : port
    this.bound = { host, port: boundPort }
    return this.bound
  }

  /**
   * Stop serving and tear down the setup access point. Safe to call when not
   * running. After a plain stop (no claim), {@link start} may be called again
   * to restart onboarding.
   */
  async stop(): Promise<void> {
    await this.closeHttp()
    await this.stopAccessPoint()
    if (this.serverState === "serving") {
      this.serverState = "closed"
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    try {
      if (path === INFO_PATH) {
        if (req.method !== "GET") {
          sendJson(res, 405, { message: "Method not allowed" })
          return
        }
        const info: ProvisioningInfo = { status: "awaiting-claim" }
        if (this.options.deviceName !== undefined) {
          info.name = this.options.deviceName
        }
        sendJson(res, 200, info)
        return
      }
      if (path === CLAIM_PATH) {
        if (req.method !== "POST") {
          sendJson(res, 405, { message: "Method not allowed" })
          return
        }
        await this.handleClaim(req, res)
        return
      }
      sendJson(res, 404, { message: "Not found" })
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: "Internal error" })
      }
      this.reportError(asError(error))
    }
  }

  private async handleClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.serverState === "provisioned") {
      sendJson(res, 409, { message: "The device is already provisioned" })
      return
    }

    let raw: Buffer
    try {
      raw = await readBody(req)
    } catch {
      sendJson(res, 413, { message: "Request body too large" })
      return
    }
    const claim = parseClaimRequest(raw)
    if (claim === null) {
      sendJson(res, 400, { message: "Expected a JSON body with a claim code" })
      return
    }

    let credential: DeviceCredential
    try {
      credential = await this.exchange(claim)
    } catch (error) {
      if (ClaimError.isError(error)) {
        sendJson(res, error.status ?? 502, { message: error.message })
        return
      }
      sendJson(res, 502, { message: "The provisioning endpoint failed" })
      return
    }

    try {
      await this.options.store.save(credential)
    } catch (error) {
      sendJson(res, 500, { message: "Claimed the device but failed to persist the credential" })
      this.reportError(asError(error))
      return
    }

    this.serverState = "provisioned"
    const identity: ProvisionedIdentity = {
      deviceId: credential.deviceId,
      teamId: credential.teamId,
      spaceId: credential.spaceId
    }
    res.writeHead(200, { "content-type": "application/json", connection: "close" })
    res.end(JSON.stringify(identity), () => {
      void this.completeProvisioning(credential)
    })
  }

  /**
   * Tear down the claim endpoint and access point, then hand the credential
   * to `onProvisioned`. Runs only after the claim response has flushed, so
   * the companion app always receives the identity before the AP drops.
   */
  private async completeProvisioning(credential: DeviceCredential): Promise<void> {
    try {
      await this.closeHttp()
      await this.stopAccessPoint()
      await this.options.onProvisioned?.(credential)
    } catch (error) {
      this.reportError(asError(error))
    }
  }

  private async closeHttp(): Promise<void> {
    const { server } = this
    if (server === null) {
      return
    }
    this.server = null
    this.bound = null
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }

  private async stopAccessPoint(): Promise<void> {
    if (!this.accessPointStarted) {
      return
    }
    this.accessPointStarted = false
    await this.options.accessPoint?.stop()
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {
      // An error listener must never take the server down.
    }
  }
}
