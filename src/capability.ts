/**
 * Device capabilities and the command wire format (Decision #241).
 *
 * A device declares what it can do as a manifest published to the reserved
 * `capabilities` topic on connect; the platform delivers commands to a live
 * device on `command/<capabilityKey>` with a JSON object payload —
 * `{"value": ...}`, or `{}` for a `trigger`.
 */

import { CapabilityError, CommandError } from "./errors.js"

/** The capability kinds a device may declare (Decision #241). */
export type CapabilityType = "onoff" | "range" | "enum" | "trigger" | "sensor"

/** A JSON-serializable value carried by a command payload. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Declaration of an on/off control, e.g. a relay. Commands carry `{"value": boolean}`. */
export type OnOffDeclaration = {
  /** Capability key, unique per device; must survive an MQTT topic level unescaped. */
  key: string
  /** Discriminant for an on/off control. */
  type: "onoff"
}

/** Declaration of a numeric range control, e.g. a dimmer. Commands carry `{"value": number}`. */
export type RangeDeclaration = {
  /** Capability key, unique per device; must survive an MQTT topic level unescaped. */
  key: string
  /** Discriminant for a range control. */
  type: "range"
  /** Lowest accepted value. */
  min: number
  /** Highest accepted value. */
  max: number
  /** UI step hint; a hint only, never a validation constraint. */
  step?: number
  /** Display unit, e.g. `"percent"`. */
  unit?: string
}

/** Declaration of a closed-set control. Commands carry `{"value": "option"}`. */
export type EnumDeclaration = {
  /** Capability key, unique per device; must survive an MQTT topic level unescaped. */
  key: string
  /** Discriminant for an enum control. */
  type: "enum"
  /** The accepted values; at least one non-empty string. */
  options: string[]
}

/** Declaration of a momentary action, e.g. a reboot. Commands carry `{}`. */
export type TriggerDeclaration = {
  /** Capability key, unique per device; must survive an MQTT topic level unescaped. */
  key: string
  /** Discriminant for a momentary action. */
  type: "trigger"
}

/**
 * Declaration of a read-only reading. Declarative only, so a dashboard can
 * place a widget before any telemetry has arrived; it takes no commands.
 */
export type SensorDeclaration = {
  /** Capability key, unique per device; must survive an MQTT topic level unescaped. */
  key: string
  /** Discriminant for a read-only reading. */
  type: "sensor"
  /** The metric name this sensor reports. */
  metric: string
  /** Display unit, e.g. `"celsius"`. */
  unit?: string
}

/** One capability as firmware declares it through the SDK. */
export type CapabilityDeclaration =
  | OnOffDeclaration
  | RangeDeclaration
  | EnumDeclaration
  | TriggerDeclaration
  | SensorDeclaration

/** One capability entry in the published manifest. */
export type ManifestCapability = {
  /** Capability key. */
  key: string
  /** Capability kind. */
  type: CapabilityType
  /**
   * Type-specific configuration: `min`/`max`/`step`/`unit` for `range`,
   * `options` for `enum`, `metric`/`unit` for `sensor`.
   */
  config: Record<string, JsonValue>
}

/** The manifest published to the reserved `capabilities` topic on connect. */
export type CapabilityManifest = {
  /** Every capability the device currently has. */
  capabilities: ManifestCapability[]
}

/**
 * A decoded command payload: a value for settable capability types, nothing
 * for a `trigger`.
 */
export type CommandPayload = { kind: "trigger" } | { kind: "value"; value: JsonValue }

/** A capability key has to survive an MQTT topic level unescaped. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i

const textDecoder = new TextDecoder()

/** Whether `key` is a valid capability key, checked the way the platform does. */
export function isValidCapabilityKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

function requireValidKey(key: string): void {
  if (!isValidCapabilityKey(key)) {
    throw new CapabilityError(`Invalid capability key: ${key}`)
  }
}

function buildConfig(declaration: CapabilityDeclaration): Record<string, JsonValue> {
  switch (declaration.type) {
    case "onoff":
    case "trigger":
      return {}
    case "range": {
      const { key, min, max, step, unit } = declaration
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new CapabilityError(`Range capability ${key} requires finite min and max`)
      }
      if (min >= max) {
        throw new CapabilityError(`Range capability ${key} requires min < max`)
      }
      if (step !== undefined && (!Number.isFinite(step) || step <= 0)) {
        throw new CapabilityError(`Range capability ${key} step must be a positive number`)
      }
      return {
        min,
        max,
        ...(step !== undefined && { step }),
        ...(unit !== undefined && { unit })
      }
    }
    case "enum": {
      const { key, options } = declaration
      if (options.length === 0 || options.some((option) => option === "")) {
        throw new CapabilityError(
          `Enum capability ${key} requires at least one non-empty string option`
        )
      }
      return { options: [...options] }
    }
    case "sensor": {
      const { key, metric, unit } = declaration
      if (metric === "") {
        throw new CapabilityError(`Sensor capability ${key} requires a metric name`)
      }
      return { metric, ...(unit !== undefined && { unit }) }
    }
  }
}

/**
 * Validate declarations and build the manifest the platform's ingest worker
 * parses. Invalid declarations throw a {@link CapabilityError} here, on the
 * device, rather than being rejected silently after publish.
 */
export function buildManifest(declarations: CapabilityDeclaration[]): CapabilityManifest {
  const seen = new Set<string>()
  const capabilities: ManifestCapability[] = []
  for (const declaration of declarations) {
    requireValidKey(declaration.key)
    if (seen.has(declaration.key)) {
      throw new CapabilityError(`Duplicate capability key: ${declaration.key}`)
    }
    seen.add(declaration.key)
    capabilities.push({
      key: declaration.key,
      type: declaration.type,
      config: buildConfig(declaration)
    })
  }
  return { capabilities }
}

/**
 * Decode an inbound command payload against the Decision #241 wire format:
 * always a JSON object — `{"value": ...}` for settable types, `{}` for a
 * trigger. Anything else throws a {@link CommandError}.
 */
export function decodeCommandPayload(data: Uint8Array): CommandPayload {
  let json: unknown
  try {
    json = JSON.parse(textDecoder.decode(data))
  } catch {
    throw new CommandError("Command payload is not valid JSON")
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CommandError("Command payload must be a JSON object")
  }
  const keys = Object.keys(json)
  if (keys.length === 0) {
    return { kind: "trigger" }
  }
  if (keys.length === 1 && keys[0] === "value") {
    return { kind: "value", value: (json as { value: JsonValue }).value }
  }
  throw new CommandError('Command payload must be {"value": ...} or {}')
}

/**
 * Check a decoded command against the capability as declared on this device.
 * A mismatch throws a {@link CommandError}; the platform validates at enqueue
 * time, so a mismatch here means the command arrived out of band.
 */
export function validateCommandValue(
  declaration: CapabilityDeclaration,
  payload: CommandPayload
): void {
  const { key } = declaration
  switch (declaration.type) {
    case "trigger":
      if (payload.kind !== "trigger") {
        throw new CommandError(`Capability ${key} takes no value`)
      }
      return
    case "sensor":
      throw new CommandError(`Capability ${key} is read-only`)
    case "onoff":
      if (payload.kind !== "value" || typeof payload.value !== "boolean") {
        throw new CommandError(`Capability ${key} requires a boolean value`)
      }
      return
    case "range":
      if (
        payload.kind !== "value" ||
        typeof payload.value !== "number" ||
        !Number.isFinite(payload.value)
      ) {
        throw new CommandError(`Capability ${key} requires a numeric value`)
      }
      if (payload.value < declaration.min || payload.value > declaration.max) {
        throw new CommandError(
          `Capability ${key} value is outside ${String(declaration.min)}..${String(declaration.max)}`
        )
      }
      return
    case "enum":
      if (
        payload.kind !== "value" ||
        typeof payload.value !== "string" ||
        !declaration.options.includes(payload.value)
      ) {
        throw new CommandError(`Capability ${key} requires one of its declared options`)
      }
      return
  }
}
