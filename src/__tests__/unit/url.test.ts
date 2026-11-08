import { describe, expect, it } from "vitest"

import { trimTrailingSlash } from "../../url.js"

describe("trimTrailingSlash", () => {
  it("drops every trailing slash and nothing else", () => {
    expect(trimTrailingSlash("https://api.example.com/")).toBe("https://api.example.com")
    expect(trimTrailingSlash("https://api.example.com///")).toBe("https://api.example.com")
    expect(trimTrailingSlash("https://api.example.com/v1")).toBe("https://api.example.com/v1")
    expect(trimTrailingSlash("")).toBe("")
    expect(trimTrailingSlash("///")).toBe("")
  })

  it("stays linear on a long run of slashes", () => {
    const value = `a${"/".repeat(100_000)}b${"/".repeat(100_000)}`
    expect(trimTrailingSlash(value)).toBe(`a${"/".repeat(100_000)}b`)
  })
})
