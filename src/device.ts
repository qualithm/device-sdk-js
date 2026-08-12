/**
 * The {@link Device} handle: a restart-safe state machine that claims once,
 * persists its credential, and maintains an auto-reconnecting MQTT-over-TLS
 * session to the Qualithm gateway.
 *
 * On first boot it exchanges a claim code and stores the resulting credential;
 * on every subsequent boot it loads the stored credential and skips claiming
 * (claim codes are single-use). Transport reconnection and backoff are handled
 * by the underlying MQTT client.
 */

import {
  connect,
  type IClientOptions,
  type IClientPublishOptions,
  type IClientSubscribeOptions,
  type MqttClient
} from "mqtt"

import {
  buildManifest,
  type CapabilityDeclaration,
  decodeCommandPayload,
  isValidCapabilityKey,
  validateCommandValue
} from "./capability.js"
import { claimDevice } from "./claim.js"
import { CapabilityError, ConnectionError, CredentialError } from "./errors.js"
import { ProvisioningServer, type ProvisioningServerOptions } from "./provision-server.js"
import { createFileCredentialStore } from "./store.js"
import type { ConnectionState, CredentialStore, DeviceCredential, DeviceOptions } from "./types.js"

const DEFAULT_PORT = 8883
const DEFAULT_RECONNECT_MS = 1000
const DEFAULT_KEEPALIVE_S = 60
const DEFAULT_STORE_PATH = ".qualithm/credential.json"
const MQTT_PROTOCOL_VERSION = 5
const COMMAND_TOPIC_PREFIX = "command/"
const COMMAND_TOPIC_FILTER = "command/#"
const MANIFEST_TOPIC = "capabilities"

/** Listener notified on every connection-state transition. */
export type StateListener = (state: ConnectionState) => void
/** Listener notified for each inbound application message. */
export type MessageListener = (topic: string, payload: Uint8Array) => void
/** Listener notified for transport-level errors. */
export type ErrorListener = (error: Error) => void
/**
 * Handler for commands addressed to one capability key. A settable
 * capability's handler receives the decoded value; a `trigger` capability's
 * handler is invoked with `undefined`.
 */
export type CommandHandler<V = unknown> = (value: V) => void

const toMessage = (payload: string | Uint8Array): string | Buffer =>
  typeof payload === "string" ? payload : Buffer.from(payload)

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))

/**
 * A connected Qualithm device.
 *
 * @example
 * ```ts
 * const device = new Device({
 *   provisioningUrl: "https://api.qualithm.com",
 *   broker: { host: "gw.de-fra-a.qualithm.com" },
 *   claimCode: process.env.QUALITHM_CLAIM_CODE
 * })
 * await device.connect()
 * await device.publish("telemetry/temperature", JSON.stringify({ c: 21.4 }))
 * ```
 */
export class Device {
  private readonly options: DeviceOptions
  private readonly store: CredentialStore
  private readonly stateListeners = new Set<StateListener>()
  private readonly messageListeners = new Set<MessageListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  private readonly commandHandlers = new Map<string, CommandHandler>()
  private declaredCapabilities = new Map<string, CapabilityDeclaration>()
  private manifestJson: string | null = null
  private commandSubscribed = false
  private hasConnectedOnce = false
  private client: MqttClient | null = null
  private credential: DeviceCredential | null = null
  private state: ConnectionState = "idle"

  constructor(options: DeviceOptions) {
    this.options = options
    this.store = options.store ?? createFileCredentialStore(DEFAULT_STORE_PATH)
    if (options.capabilities !== undefined) {
      this.setCapabilities(options.capabilities)
    }
  }

  /** The current connection state. */
  get connectionState(): ConnectionState {
    return this.state
  }

  /** The active device credential once provisioned, otherwise `null`. */
  get identity(): DeviceCredential | null {
    return this.credential
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe function. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Subscribe to transport errors. Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /**
   * Register a handler for commands addressed to one capability key.
   *
   * The SDK subscribes `command/#` once and dispatches by key, decoding the
   * Decision #241 payload first: a settable capability's handler receives the
   * decoded value; a `trigger` capability's handler is invoked with no value.
   * A malformed payload or a throwing handler is reported through `onError`
   * without interrupting dispatch. Returns an unregister function.
   */
  onCommand<V>(key: string, handler: CommandHandler<V>): () => void {
    if (!isValidCapabilityKey(key)) {
      throw new CapabilityError(`Invalid capability key: ${key}`)
    }
    if (this.declaredCapabilities.get(key)?.type === "sensor") {
      throw new CapabilityError(`Capability ${key} is read-only`)
    }
    this.commandHandlers.set(key, handler as CommandHandler)
    void this.ensureCommandSubscription().catch((error: unknown) => {
      this.emitError(asError(error))
    })
    return () => {
      this.commandHandlers.delete(key)
    }
  }

  /**
   * Declare (or re-declare) the device's capability set. The manifest is
   * validated locally, published on the current session, and re-published on
   * every subsequent connect. Throws a `CapabilityError` on an invalid
   * declaration.
   */
  async declareCapabilities(declarations: CapabilityDeclaration[]): Promise<void> {
    this.setCapabilities(declarations)
    await this.publishManifest()
  }

  /**
   * Start soft-AP provisioning mode (Decision #280): serve the claim exchange
   * on the device's setup network until the companion app claims the device.
   *
   * Only available before a gateway session exists — never alongside one. A
   * successful claim persists the credential, stops the server and the setup
   * access point, and invokes `onProvisioned`; `connect()` then proceeds with
   * the stored credential. While the server is serving, the device's state is
   * `provisioning`.
   *
   * @throws {@link ConnectionError} when a gateway session is active or the
   * device is closed.
   * @throws {@link ProvisioningError} when the device is already provisioned
   * or the server fails to start.
   */
  async startProvisioning(
    options?: Omit<ProvisioningServerOptions, "provisioningUrl" | "store">
  ): Promise<ProvisioningServer> {
    if (this.state !== "idle" && this.state !== "provisioning") {
      throw new ConnectionError("Cannot start provisioning while a gateway session is active")
    }
    const server = new ProvisioningServer({
      ...options,
      provisioningUrl: this.options.provisioningUrl,
      store: this.store,
      deviceName: options?.deviceName ?? this.options.name,
      onProvisioned: async (credential) => {
        this.credential = credential
        await options?.onProvisioned?.(credential)
      }
    })
    this.setState("provisioning")
    try {
      await server.start()
    } catch (error) {
      this.setState("idle")
      throw error
    }
    return server
  }

  /**
   * Provision (claim once, or load the stored credential) and open the
   * auto-reconnecting MQTT-over-TLS session. Resolves once connected.
   */
  async connect(): Promise<void> {
    const credential = await this.provision()
    this.credential = credential
    await this.openConnection(credential)
  }

  /** Publish a payload to a (device-relative) topic. */
  async publish(
    topic: string,
    payload: string | Uint8Array,
    options?: IClientPublishOptions
  ): Promise<void> {
    const client = this.requireClient()
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, toMessage(payload), options ?? {}, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  /** Subscribe to one or more (device-relative) topic filters. */
  async subscribe(topic: string | string[], options?: IClientSubscribeOptions): Promise<void> {
    const client = this.requireClient()
    await new Promise<void>((resolve, reject) => {
      client.subscribe(topic, options ?? { qos: 0 }, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  /** Gracefully close the session. The state becomes `closed` (terminal). */
  async disconnect(): Promise<void> {
    this.setState("closed")
    const { client } = this
    if (client === null) {
      return
    }
    await new Promise<void>((resolve) => {
      client.end(false, {}, () => {
        resolve()
      })
    })
    this.client = null
    this.commandSubscribed = false
    this.hasConnectedOnce = false
  }

  /** Load the stored credential, or claim once and persist it. */
  private async provision(): Promise<DeviceCredential> {
    const existing = await this.store.load()
    if (existing !== null) {
      return existing
    }

    const { claimCode } = this.options
    if (claimCode === undefined || claimCode === "") {
      throw new CredentialError("No stored credential and no claim code provided")
    }

    this.setState("provisioning")
    const claimed = await claimDevice(this.options.provisioningUrl, {
      code: claimCode,
      ...(this.options.name !== undefined && { name: this.options.name })
    })
    await this.store.save(claimed)
    return claimed
  }

  private async openConnection(credential: DeviceCredential): Promise<void> {
    this.setState("connecting")
    const client = connect(this.buildClientOptions(credential))
    this.client = client
    this.bindClientEvents(client)
    await this.waitForConnect(client)
    await this.publishManifest()
    await this.ensureCommandSubscription()
  }

  private buildClientOptions(credential: DeviceCredential): IClientOptions {
    const { broker } = this.options
    const base: IClientOptions = {
      host: broker.host,
      port: broker.port ?? DEFAULT_PORT,
      protocol: "mqtts",
      protocolVersion: MQTT_PROTOCOL_VERSION,
      clientId: credential.deviceId,
      clean: true,
      keepalive: this.options.keepaliveSeconds ?? DEFAULT_KEEPALIVE_S,
      reconnectPeriod: this.options.reconnectPeriodMs ?? DEFAULT_RECONNECT_MS,
      ...(broker.ca !== undefined && { ca: broker.ca }),
      ...(broker.rejectUnauthorized !== undefined && {
        rejectUnauthorized: broker.rejectUnauthorized
      })
    }

    if (credential.kind === "cert") {
      if (credential.privateKeyPem === undefined || credential.certificatePem === undefined) {
        throw new CredentialError("Certificate credential is missing key or certificate material")
      }
      return { ...base, key: credential.privateKeyPem, cert: credential.certificatePem }
    }

    if (credential.token === undefined || credential.token === "") {
      throw new CredentialError("Token credential is missing its secret")
    }
    return { ...base, username: credential.deviceId, password: credential.token }
  }

  private bindClientEvents(client: MqttClient): void {
    client.on("connect", () => {
      this.setState("connected")
      if (this.hasConnectedOnce) {
        // A reconnect re-declares the manifest; the platform upserts it.
        void this.publishManifest().catch((error: unknown) => {
          this.emitError(asError(error))
        })
      }
      this.hasConnectedOnce = true
    })
    client.on("reconnect", () => {
      this.setState("reconnecting")
    })
    client.on("close", () => {
      if (this.state !== "closed") {
        this.setState("reconnecting")
      }
    })
    client.on("message", (topic, payload) => {
      if (topic.startsWith(COMMAND_TOPIC_PREFIX)) {
        this.dispatchCommand(topic, payload)
      }
      this.emitMessage(topic, payload)
    })
    client.on("error", (error) => {
      this.emitError(error)
    })
  }

  private setCapabilities(declarations: CapabilityDeclaration[]): void {
    this.manifestJson = JSON.stringify(buildManifest(declarations))
    this.declaredCapabilities = new Map(declarations.map((d) => [d.key, d]))
  }

  /** Publish the capability manifest, when one is declared and a session is live. */
  private async publishManifest(): Promise<void> {
    if (this.manifestJson === null || this.state !== "connected") {
      return
    }
    await this.publish(MANIFEST_TOPIC, this.manifestJson)
  }

  /** Subscribe `command/#` once per session, when at least one handler is registered. */
  private async ensureCommandSubscription(): Promise<void> {
    if (this.commandSubscribed || this.commandHandlers.size === 0 || this.state !== "connected") {
      return
    }
    await this.subscribe(COMMAND_TOPIC_FILTER)
    this.commandSubscribed = true
  }

  /**
   * Route one inbound `command/<key>` message to its registered handler. A
   * malformed payload, a value that does not fit the declared capability, or
   * a throwing handler surfaces through `onError` — never by escaping into
   * the client's message loop.
   */
  private dispatchCommand(topic: string, payload: Uint8Array): void {
    const key = topic.slice(COMMAND_TOPIC_PREFIX.length)
    const handler = this.commandHandlers.get(key)
    if (handler === undefined) {
      return
    }
    try {
      const decoded = decodeCommandPayload(payload)
      const declared = this.declaredCapabilities.get(key)
      if (declared !== undefined) {
        validateCommandValue(declared, decoded)
      }
      handler(decoded.kind === "value" ? decoded.value : undefined)
    } catch (error) {
      this.emitError(asError(error))
    }
  }

  private async waitForConnect(client: MqttClient): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        client.removeListener("error", onError)
        resolve()
      }
      const onError = (error: Error): void => {
        client.removeListener("connect", onConnect)
        reject(new ConnectionError("Failed to connect to the gateway", { cause: error }))
      }
      client.once("connect", onConnect)
      client.once("error", onError)
    })
  }

  private requireClient(): MqttClient {
    if (this.client === null) {
      throw new ConnectionError("Device is not connected")
    }
    return this.client
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  private emitMessage(topic: string, payload: Uint8Array): void {
    for (const listener of this.messageListeners) {
      listener(topic, payload)
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error)
    }
  }
}
