import { afterEach, describe, expect, it, vi } from "vitest"

import { describeError, printError, printResult } from "../../../cli/output.js"

describe("printResult", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prints the human message by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    printResult(false, "Claimed device d", { deviceId: "d" })
    expect(log).toHaveBeenCalledWith("Claimed device d")
  })

  it("prints a JSON line in --json mode", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    printResult(true, "Claimed device d", { deviceId: "d" })
    expect(log).toHaveBeenCalledWith(JSON.stringify({ deviceId: "d" }))
  })
})

describe("printError", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prints a human error message by default", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    printError(false, new Error("boom"))
    expect(error).toHaveBeenCalledWith("Error: boom")
  })

  it("prints a JSON error line in --json mode", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    printError(true, new Error("boom"))
    expect(error).toHaveBeenCalledWith(JSON.stringify({ error: "boom" }))
  })

  it("includes the cause in the human message", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const cause = new Error("unable to get local issuer certificate")
    printError(false, new Error("Failed to connect to the gateway", { cause }))
    expect(error).toHaveBeenCalledWith(
      "Error: Failed to connect to the gateway: unable to get local issuer certificate"
    )
  })

  it("includes the cause in the --json error field", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const cause = new Error("unable to get local issuer certificate")
    printError(true, new Error("Failed to connect to the gateway", { cause }))
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Failed to connect to the gateway: unable to get local issuer certificate"
      })
    )
  })

  it("stringifies a non-Error value", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    printError(false, "plain string")
    expect(error).toHaveBeenCalledWith("Error: plain string")
  })
})

describe("describeError", () => {
  it("joins a nested cause chain", () => {
    const root = new Error("ECONNREFUSED")
    const mid = new Error("socket closed", { cause: root })
    expect(describeError(new Error("outer", { cause: mid }))).toBe(
      "outer: socket closed: ECONNREFUSED"
    )
  })

  it("skips empty and repeated cause messages", () => {
    const repeated = new Error("outer", { cause: new Error("outer", { cause: new Error("") }) })
    expect(describeError(repeated)).toBe("outer")
  })

  it("stringifies a non-Error cause", () => {
    expect(describeError(new Error("outer", { cause: "timeout" }))).toBe("outer: timeout")
  })

  it("stops at a bounded depth on a cyclic cause", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    a.cause = b
    expect(describeError(a)).toBe("a: b")
  })
})
