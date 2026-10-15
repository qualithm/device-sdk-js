import { describe, expect, it } from "vitest"

import { RECONNECT_CAP_MS, RECONNECT_FLOOR_MS, reconnectDelay } from "../../backoff.js"

const top = (): number => 0.999999

describe("reconnectDelay", () => {
  it("doubles the ceiling with each consecutive failure", () => {
    expect(reconnectDelay(1, 1000, RECONNECT_CAP_MS, top)).toBe(999)
    expect(reconnectDelay(2, 1000, RECONNECT_CAP_MS, top)).toBe(1999)
    expect(reconnectDelay(3, 1000, RECONNECT_CAP_MS, top)).toBe(3999)
  })

  it("caps the ceiling", () => {
    expect(reconnectDelay(6, 1000, RECONNECT_CAP_MS, top)).toBe(29_999)
    expect(reconnectDelay(5000, 1000, RECONNECT_CAP_MS, top)).toBe(29_999)
    expect(reconnectDelay(3, 1000, 2500, top)).toBe(2499)
  })

  it("jitters within [floor, ceiling)", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ceiling = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** (attempt - 1))
      for (let i = 0; i < 50; i++) {
        const delay = reconnectDelay(attempt, 1000)
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_FLOOR_MS)
        expect(delay).toBeLessThan(ceiling)
      }
    }
    expect(reconnectDelay(4, 1000, RECONNECT_CAP_MS, () => 0.5)).toBe(4000)
  })

  it("never drops below the floor on a zero draw", () => {
    expect(reconnectDelay(1, 1000, RECONNECT_CAP_MS, () => 0)).toBe(RECONNECT_FLOOR_MS)
  })

  it("treats a reset count like the first failure", () => {
    expect(reconnectDelay(0, 1000, RECONNECT_CAP_MS, top)).toBe(999)
  })

  it("defaults the cap to 30 s", () => {
    expect(reconnectDelay(20, 1000, undefined, top)).toBe(29_999)
  })
})
