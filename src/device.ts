/**
 * The {@link Device} handle: a restart-safe state machine that claims once,
 * persists its credential, and maintains an auto-reconnecting MQTT-over-TLS
 * session to the Qualithm gateway.
 *
 * On first boot it exchanges a claim code and stores the resulting credential;
 * on every subsequent boot it loads the stored credential and skips claiming
 * (claim codes are single-use). The underlying MQTT client reconnects; the
 * device grows its delay exponentially with jitter (`backoff.ts`).
 */

import {
  connect,
  type IClientOptions,
  type IClientPublishOptions,
  type IClientSubscribeOptions,
  type MqttClient
} from "mqtt"

import { reconnectDelay } from "./backoff.js"
import {
  buildManifest,
  type CapabilityDeclaration,
  decodeCommandPayload,
  isValidCapabilityKey,
  validateCommandValue
} from "./capability.js"
import { claimDevice } from "./claim.js"
import {
  CapabilityError,
  ConnectionError,
  CredentialError,
  PayloadTooLargeError,
  RenewalError,
  TopicError
} from "./errors.js"
import { ProvisioningServer, type ProvisioningServerOptions } from "./provision-server.js"
import { assertNotExpired, renewalTime, renewCredential } from "./renew.js"
import { createFileCredentialStore } from "./store.js"
import type {
  BrokerEndpoint,
  BrokerOptions,
  ConnectionState,
  CredentialStore,
  DeviceCredential,
  DeviceOptions
} from "./types.js"

const DEFAULT_PORT = 8883
const DEFAULT_RECONNECT_MS = 1000
const DEFAULT_KEEPALIVE_S = 60
const DEFAULT_STORE_PATH = ".qualithm/credential.json"
const MQTT_PROTOCOL_VERSION = 5
const COMMAND_TOPIC_PREFIX = "command/"
const COMMAND_TOPIC_FILTER = "command/#"
const MANIFEST_TOPIC = "capabilities"
const TELEMETRY_TOPIC = "telemetry"
/** Publishes of one message, including the first, before a failed PUBACK is final. */
const PUBLISH_ATTEMPTS = 5
/** The ceiling of the first wait before re-publishing, in milliseconds. */
const PUBLISH_RETRY_BASE_MS = 500
/** The largest wait before re-publishing, in milliseconds. */
const PUBLISH_RETRY_CAP_MS = 10_000
/** The ceiling of the first wait before retrying a failed renewal, in milliseconds. */
const RENEW_RETRY_BASE_MS = 60_000
/** The largest wait before retrying a failed renewal, in milliseconds. */
const RENEW_RETRY_CAP_MS = 3_600_000
/** The longest delay `setTimeout` accepts; a later renewal is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647
/** User property naming one message across its re-publishes, for gateway dedup. */
const MSG_ID_PROPERTY = "msg-id"

/**
 * Refuse a topic the gateway doesn't accept a publish on: anything but
 * `telemetry`, `capabilities` or a `command/<key>` response.
 *
 * @throws {@link TopicError} for any other topic
 */
export const assertContractTopic = (topic: string): void => {
  if (topic === TELEMETRY_TOPIC || topic === MANIFEST_TOPIC) {
    return
  }
  if (
    topic.startsWith(COMMAND_TOPIC_PREFIX) &&
    isValidCapabilityKey(topic.slice(COMMAND_TOPIC_PREFIX.length))
  ) {
    return
  }
  throw new TopicError(
    `the gateway accepts no publish on ${topic}: publish readings to telemetry, or a command response to command/<key>`
  )
}

/** True when `error` is a PUBACK whose reason code says the gateway did not take the message. */
const isFailedPuback = (error: Error): boolean =>
  "code" in error && typeof error.code === "number" && error.code >= 0x80

/** Publish options carrying a `msg-id` user property, keeping one the caller set. */
const withMsgId = (options: IClientPublishOptions): IClientPublishOptions => {
  const userProperties = options.properties?.userProperties ?? {}
  if (MSG_ID_PROPERTY in userProperties) {
    return options
  }
  return {
    ...options,
    properties: {
      ...options.properties,
      userProperties: { ...userProperties, [MSG_ID_PROPERTY]: crypto.randomUUID() }
    }
  }
}

/** How one renewal attempt ended. */
type Renewal = { ok: true; credential: DeviceCredential } | { ok: false; error: Error }

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
 * Choose the gateway to connect to. A configured host wins; otherwise the device uses the broker
 * the platform returned at enrollment, so it needs no hardcoded host. A configured port overrides
 * either source's port.
 *
 * @param configured - The `broker` passed to the {@link Device}
 * @param credential - The stored credential, carrying the enrolled broker
 * @throws {@link ConnectionError} when neither names a host
 */
export const resolveBroker = (
  configured: BrokerOptions | undefined,
  credential: DeviceCredential
): BrokerEndpoint => {
  if (configured?.host !== undefined && configured.host !== "") {
    return { host: configured.host, port: configured.port ?? DEFAULT_PORT }
  }
  if (credential.broker !== undefined) {
    return { host: credential.broker.host, port: configured?.port ?? credential.broker.port }
  }
  throw new ConnectionError(
    "no broker host is configured and the stored credential names none: set broker.host"
  )
}

/**
 * A connected Qualithm device.
 *
 * @example
 * ```ts
 * const device = new Device({
 *   provisioningUrl: "https://api.qualithm.com",
 *   claimCode: process.env.QUALITHM_CLAIM_CODE
 * })
 * await device.connect()
 * await device.publish(
 *   "telemetry",
 *   JSON.stringify({ ts: Date.now(), metrics: { temperature: 21.4 } })
 * )
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
  /**
   * The event payload ceiling the gateway advertised in CONNACK
   * (`maximumPacketSize`, qualithm/pm#126). `null` until the first successful
   * connect; the publish guard only fires once the gateway has told us the
   * limit, so an unadvertised connection is never blocked client-side.
   */
  private maxEventBytes: number | null = null
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private renewFailures = 0

  constructor(options: DeviceOptions) {
    this.options = options
    this.store = options.store ?? createFileCredentialStore(DEFAULT_STORE_PATH)
    // The type requires a non-empty list; JavaScript callers get the same rule at runtime.
    const declared = options.capabilities as CapabilityDeclaration[] | undefined
    if (declared === undefined || declared.length === 0) {
      throw new CapabilityError("no capabilities declared: declare at least one in capabilities")
    }
    this.setCapabilities(declared)
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
   * payload first: a settable capability's handler receives the decoded value;
   * a `trigger` capability's handler is invoked with no value.
   * A malformed payload or a throwing handler is reported through `onError`
   * without interrupting dispatch. Returns an unregister function.
   */
  onCommand<V>(key: string, handler: CommandHandler<V>): () => void {
    if (!isValidCapabilityKey(key)) {
      throw new CapabilityError(
        `capability key ${key} is not valid: use 1 to 64 letters, digits, "_" or "-", starting with a letter or digit`
      )
    }
    if (this.declaredCapabilities.get(key)?.type === "sensor") {
      throw new CapabilityError(`capability ${key} is a read-only sensor and takes no commands`)
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
   * Start soft-AP provisioning mode: serve the claim exchange on the device's
   * setup network until the companion app claims the device.
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
      throw new ConnectionError(
        "cannot start provisioning while a gateway session is active: call disconnect() first"
      )
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
    const stored = await this.provision()
    assertNotExpired(stored)
    const due = renewalTime(stored)
    const renewal = due !== undefined && due <= Date.now() ? await this.renew(stored) : undefined
    const credential = renewal?.ok === true ? renewal.credential : stored
    this.credential = credential
    await this.openConnection(credential)
    this.scheduleRenewal()
  }

  /**
   * Publish a payload to a (device-relative) topic: `telemetry` for
   * readings, or `command/<key>` for a command response. The gateway accepts
   * no other topic.
   *
   * A QoS 1 publish carries a `msg-id` user property. When the gateway answers
   * it with a failed PUBACK (reason code 0x80 or above), it is published again
   * with the same `msg-id`, after a capped, jittered backoff, so the gateway
   * stores it once.
   *
   * @throws {@link TopicError} for a topic the gateway doesn't accept.
   * @throws {@link PayloadTooLargeError} when the payload exceeds the ceiling
   * the gateway advertised in CONNACK (qualithm/pm#126) — caught before the bytes
   * go on the wire, so the device is told rather than silently dropped.
   * @throws the last failed PUBACK's error once every attempt has failed.
   */
  async publish(
    topic: string,
    payload: string | Uint8Array,
    options?: IClientPublishOptions
  ): Promise<void> {
    assertContractTopic(topic)
    const client = this.requireClient()
    const message = toMessage(payload)
    const max = this.maxEventBytes
    if (max !== null && message.length > max) {
      throw new PayloadTooLargeError(
        `event payload of ${String(message.length)} bytes exceeds the gateway's ${String(max)}-byte limit`,
        { maxBytes: max, actualBytes: message.length }
      )
    }
    const opts = options?.qos === 1 ? withMsgId(options) : (options ?? {})
    for (let attempt = 1; ; attempt++) {
      try {
        await this.publishOnce(attempt === 1 ? client : this.requireClient(), topic, message, opts)
        return
      } catch (error) {
        if (!(error instanceof Error) || !isFailedPuback(error) || attempt >= PUBLISH_ATTEMPTS) {
          throw error
        }
        await new Promise((resolve) =>
          setTimeout(resolve, reconnectDelay(attempt, PUBLISH_RETRY_BASE_MS, PUBLISH_RETRY_CAP_MS))
        )
      }
    }
  }

  private async publishOnce(
    client: MqttClient,
    topic: string,
    message: string | Buffer,
    options: IClientPublishOptions
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, message, options, (error) => {
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
    this.clearRenewal()
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
      throw new CredentialError(
        "no stored credential and no claim code: set claimCode to claim the device"
      )
    }

    this.setState("provisioning")
    const claimed = await claimDevice(this.options.provisioningUrl, {
      code: claimCode,
      ...(this.options.name !== undefined && { name: this.options.name })
    })
    await this.store.save(claimed)
    return claimed
  }

  /**
   * Renew `credential` and store the new one, then switch to it. The old one
   * stays in use, and stored, until the new one is saved. A failure is
   * reported through `onError` and retried later.
   *
   * @returns the new credential, or the error when renewal failed
   */
  private async renew(credential: DeviceCredential): Promise<Renewal> {
    let renewed: DeviceCredential
    try {
      renewed = await renewCredential(this.options.provisioningUrl, credential)
      await this.store.save(renewed)
    } catch (error) {
      this.renewFailures += 1
      const failure = asError(error)
      this.emitError(failure)
      return { ok: false, error: failure }
    }
    this.renewFailures = 0
    this.credential = renewed
    const { client } = this
    if (client !== null) {
      // The next reconnect presents the new credential.
      Object.assign(client.options, this.credentialOptions(renewed))
    }
    return { ok: true, credential: renewed }
  }

  /** Arm the timer for the next renewal of the current credential, or a retry after a failure. */
  private scheduleRenewal(lastError?: Error): void {
    this.clearRenewal()
    const { credential } = this
    if (credential === null || this.state === "closed") {
      return
    }
    if (RenewalError.isError(lastError) && !lastError.retryable) {
      return
    }
    const due = renewalTime(credential)
    if (due === undefined) {
      return
    }
    const wait =
      this.renewFailures > 0
        ? reconnectDelay(this.renewFailures, RENEW_RETRY_BASE_MS, RENEW_RETRY_CAP_MS)
        : due - Date.now()
    const timer = setTimeout(
      () => {
        void this.onRenewalTimer()
      },
      Math.min(MAX_TIMER_MS, Math.max(0, wait))
    )
    // A pending renewal never keeps the process alive.
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref()
    }
    this.renewTimer = timer
  }

  private async onRenewalTimer(): Promise<void> {
    this.renewTimer = null
    const { credential } = this
    if (credential === null || this.state === "closed") {
      return
    }
    const due = renewalTime(credential)
    if (due !== undefined && due > Date.now() && this.renewFailures === 0) {
      // A timer capped below a far-off renewal re-arms instead.
      this.scheduleRenewal()
      return
    }
    const renewal = await this.renew(credential)
    this.scheduleRenewal(renewal.ok ? undefined : renewal.error)
  }

  private clearRenewal(): void {
    if (this.renewTimer !== null) {
      clearTimeout(this.renewTimer)
      this.renewTimer = null
    }
  }

  private async openConnection(credential: DeviceCredential): Promise<void> {
    this.setState("connecting")
    const client = connect(this.buildClientOptions(credential))
    this.client = client
    this.bindClientEvents(client)
    try {
      await this.waitForConnect(client)
    } catch (error) {
      // A failed first connect must not leave mqtt.js reconnecting in the
      // background, which keeps the process alive. Reconnects after an
      // established session are handled by the client and never reach here.
      this.client = null
      this.setState("idle")
      client.end(true)
      throw error
    }
    await this.publishManifest()
    await this.ensureCommandSubscription()
  }

  private buildClientOptions(credential: DeviceCredential): IClientOptions {
    const { broker } = this.options
    const endpoint = resolveBroker(broker, credential)
    const base: IClientOptions = {
      host: endpoint.host,
      port: endpoint.port,
      protocol: "mqtts",
      protocolVersion: MQTT_PROTOCOL_VERSION,
      clientId: credential.deviceId,
      clean: true,
      keepalive: this.options.keepaliveSeconds ?? DEFAULT_KEEPALIVE_S,
      reconnectPeriod: this.options.reconnectPeriodMs ?? DEFAULT_RECONNECT_MS,
      ...(broker?.ca !== undefined && { ca: broker.ca }),
      ...(broker?.rejectUnauthorized !== undefined && {
        rejectUnauthorized: broker.rejectUnauthorized
      })
    }

    return { ...base, ...this.credentialOptions(credential) }
  }

  /** The client options that present `credential` to the gateway. */
  private credentialOptions(credential: DeviceCredential): IClientOptions {
    if (credential.kind === "cert") {
      if (credential.privateKeyPem === undefined || credential.certificatePem === undefined) {
        throw new CredentialError(
          "stored certificate credential is missing its private key or certificate"
        )
      }
      return { key: credential.privateKeyPem, cert: credential.certificatePem }
    }

    if (credential.token === undefined || credential.token === "") {
      throw new CredentialError("stored token credential is missing its secret")
    }
    return { username: credential.deviceId, password: credential.token }
  }

  private bindClientEvents(client: MqttClient): void {
    this.bindReconnectBackoff(client)
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

  /**
   * mqtt.js 5 retries on a fixed `reconnectPeriod`, but reads that option each
   * time it arms its retry timer (`_setupReconnect`, from its own `close`
   * listener or `_cleanUp`). Keeping `client.options.reconnectPeriod` at the
   * next backoff delay varies the wait per attempt while mqtt.js keeps owning
   * the timer, so `end()` still clears it and never re-arms it. The `close`
   * listener is prepended to run before mqtt.js's own.
   */
  private bindReconnectBackoff(client: MqttClient): void {
    const base = this.options.reconnectPeriodMs ?? DEFAULT_RECONNECT_MS
    if (base <= 0) {
      return
    }
    let failures = 0
    const arm = (): void => {
      client.options.reconnectPeriod = reconnectDelay(Math.max(1, failures), base)
    }
    client.on("connect", () => {
      failures = 0
      arm()
    })
    client.prependListener("close", () => {
      failures += 1
      arm()
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
      const onConnect = (connack?: { properties?: { maximumPacketSize?: number } }): void => {
        client.removeListener("error", onError)
        // Capture the gateway's advertised event ceiling (qualithm/pm#126) for the
        // publish guard. An absent property leaves the guard inert.
        const advertised = connack?.properties?.maximumPacketSize
        this.maxEventBytes = typeof advertised === "number" ? advertised : null
        resolve()
      }
      const onError = (error: Error): void => {
        client.removeListener("connect", onConnect)
        reject(new ConnectionError("could not connect to the gateway", { cause: error }))
      }
      client.once("connect", onConnect)
      client.once("error", onError)
    })
  }

  private requireClient(): MqttClient {
    if (this.client === null) {
      throw new ConnectionError("device is not connected: call connect() first")
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
