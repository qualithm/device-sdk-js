import { afterEach, describe, expect, it, vi } from "vitest"

import { printError, printResult } from "../../../cli/output.js"

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

  it("stringifies a non-Error value", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    printError(false, "plain string")
    expect(error).toHaveBeenCalledWith("Error: plain string")
  })
})
