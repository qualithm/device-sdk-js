import { describe, expect, it } from "vitest"

import {
  buildManifest,
  type CapabilityDeclaration,
  decodeCommandPayload,
  isValidCapabilityKey,
  validateCommandValue
} from "../../capability.js"
import { CapabilityError, CommandError } from "../../errors.js"

const encoder = new TextEncoder()

describe("buildManifest", () => {
  it("builds the Decision #241 manifest shape for every capability type", () => {
    const manifest = buildManifest([
      { key: "power", type: "onoff" },
      { key: "brightness", type: "range", min: 0, max: 100, step: 1, unit: "percent" },
      { key: "mode", type: "enum", options: ["auto", "manual"] },
      { key: "reboot", type: "trigger" },
      { key: "temperature", type: "sensor", metric: "temperature_c", unit: "celsius" }
    ])
    expect(manifest).toEqual({
      capabilities: [
        { key: "power", type: "onoff", config: {} },
        {
          key: "brightness",
          type: "range",
          config: { min: 0, max: 100, step: 1, unit: "percent" }
        },
        { key: "mode", type: "enum", config: { options: ["auto", "manual"] } },
        { key: "reboot", type: "trigger", config: {} },
        {
          key: "temperature",
          type: "sensor",
          config: { metric: "temperature_c", unit: "celsius" }
        }
      ]
    })
  })

  it("omits unset optional config keys", () => {
    const manifest = buildManifest([{ key: "brightness", type: "range", min: 0, max: 1 }])
    expect(manifest.capabilities[0]?.config).toEqual({ min: 0, max: 1 })
  })

  it("rejects keys that cannot survive an MQTT topic level", () => {
    expect(isValidCapabilityKey("power-1")).toBe(true)
    expect(isValidCapabilityKey("bad key")).toBe(false)
    expect(isValidCapabilityKey("bad/key")).toBe(false)
    expect(isValidCapabilityKey("")).toBe(false)
    expect(() => buildManifest([{ key: "bad key", type: "onoff" }])).toThrow(CapabilityError)
  })

  it("rejects a duplicate capability key", () => {
    expect(() =>
      buildManifest([
        { key: "power", type: "onoff" },
        { key: "power", type: "trigger" }
      ])
    ).toThrow(CapabilityError)
  })

  it("rejects an invalid range config", () => {
    expect(() => buildManifest([{ key: "r", type: "range", min: 5, max: 5 }])).toThrow(
      CapabilityError
    )
    expect(() => buildManifest([{ key: "r", type: "range", min: 0, max: 1, step: 0 }])).toThrow(
      CapabilityError
    )
    expect(() => buildManifest([{ key: "r", type: "range", min: Number.NaN, max: 1 }])).toThrow(
      CapabilityError
    )
  })

  it("rejects an empty or blank enum option set", () => {
    expect(() => buildManifest([{ key: "m", type: "enum", options: [] }])).toThrow(CapabilityError)
    expect(() => buildManifest([{ key: "m", type: "enum", options: [""] }])).toThrow(
      CapabilityError
    )
  })

  it("rejects a sensor without a metric name", () => {
    expect(() => buildManifest([{ key: "t", type: "sensor", metric: "" }])).toThrow(CapabilityError)
  })
})

describe("decodeCommandPayload", () => {
  it("decodes the Decision #241 shapes", () => {
    expect(decodeCommandPayload(encoder.encode("{}"))).toEqual({ kind: "trigger" })
    expect(decodeCommandPayload(encoder.encode('{"value":true}'))).toEqual({
      kind: "value",
      value: true
    })
    expect(decodeCommandPayload(encoder.encode('{"value":0.5}'))).toEqual({
      kind: "value",
      value: 0.5
    })
    expect(decodeCommandPayload(encoder.encode('{"value":"high"}'))).toEqual({
      kind: "value",
      value: "high"
    })
  })

  it("rejects payloads that are not the documented shape", () => {
    for (const bad of ["not json", "[1]", '"x"', "1", '{"v":1}', '{"value":1,"x":2}']) {
      expect(() => decodeCommandPayload(encoder.encode(bad))).toThrow(CommandError)
    }
  })
})

describe("validateCommandValue", () => {
  const onoff: CapabilityDeclaration = { key: "power", type: "onoff" }
  const range: CapabilityDeclaration = { key: "brightness", type: "range", min: 0, max: 100 }
  const enumeration: CapabilityDeclaration = {
    key: "mode",
    type: "enum",
    options: ["auto", "manual"]
  }
  const trigger: CapabilityDeclaration = { key: "reboot", type: "trigger" }
  const sensor: CapabilityDeclaration = { key: "temp", type: "sensor", metric: "temperature_c" }

  it("accepts values that fit the declared type", () => {
    expect(() => {
      validateCommandValue(onoff, { kind: "value", value: true })
    }).not.toThrow()
    expect(() => {
      validateCommandValue(range, { kind: "value", value: 50 })
    }).not.toThrow()
    expect(() => {
      validateCommandValue(enumeration, { kind: "value", value: "auto" })
    }).not.toThrow()
    expect(() => {
      validateCommandValue(trigger, { kind: "trigger" })
    }).not.toThrow()
  })

  it("rejects values that do not fit the declared type", () => {
    expect(() => {
      validateCommandValue(onoff, { kind: "value", value: 1 })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(onoff, { kind: "trigger" })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(range, { kind: "value", value: "high" })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(range, { kind: "value", value: 101 })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(enumeration, { kind: "value", value: "turbo" })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(trigger, { kind: "value", value: true })
    }).toThrow(CommandError)
  })

  it("rejects any command to a read-only sensor", () => {
    expect(() => {
      validateCommandValue(sensor, { kind: "trigger" })
    }).toThrow(CommandError)
    expect(() => {
      validateCommandValue(sensor, { kind: "value", value: 1 })
    }).toThrow(CommandError)
  })
})
