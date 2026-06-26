/**
 * Benchmarks entry point.
 *
 * Run with: bun run bench
 *
 * Example with configuration:
 *   WARMUP_ITERATIONS=20 BENCH_ITERATIONS=1000 bun run bench
 */

/* eslint-disable no-console */

import { createMemoryCredentialStore, Device } from "../src/index"
import type { DeviceCredential, DeviceOptions } from "../src/types"

const sampleCredential: DeviceCredential = {
  deviceId: "11111111-1111-1111-1111-111111111111",
  teamId: "team-1",
  spaceId: "space-1",
  kind: "token",
  token: "qmd_0123456789abcdef0123456789abcdef",
  issuedAt: "2026-01-01T00:00:00.000Z"
}
const sampleSerialized = JSON.stringify(sampleCredential)
const deviceOptions: DeviceOptions = {
  provisioningUrl: "https://api.qualithm.com",
  broker: { host: "gw.example.qualithm.com" },
  store: createMemoryCredentialStore()
}

const config = {
  warmupIterations: parseInt(process.env.WARMUP_ITERATIONS ?? "15", 10),
  benchmarkIterations: parseInt(process.env.BENCH_ITERATIONS ?? "100000", 10)
}

type BenchmarkResult = {
  name: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  stdDev: number
  cv: number // coefficient of variation (%)
}

function calculateStats(times: number[]): {
  avg: number
  min: number
  max: number
  stdDev: number
  cv: number
} {
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const min = Math.min(...times)
  const max = Math.max(...times)
  const variance = times.reduce((sum, t) => sum + (t - avg) ** 2, 0) / times.length
  const stdDev = Math.sqrt(variance)
  const cv = (stdDev / avg) * 100

  return { avg, min, max, stdDev, cv }
}

function runBenchmark(
  name: string,
  fn: () => void,
  iterations: number,
  warmupIterations: number
): BenchmarkResult {
  // Warmup phase
  for (let i = 0; i < warmupIterations; i++) {
    fn()
  }

  // Execute benchmark in batches for timing
  const batchSize = Math.max(1, Math.floor(iterations / 100))
  const batchTimes: number[] = []

  let remaining = iterations
  while (remaining > 0) {
    const batch = Math.min(batchSize, remaining)
    const start = performance.now()
    for (let i = 0; i < batch; i++) {
      fn()
    }
    const end = performance.now()
    batchTimes.push((end - start) / batch)
    remaining -= batch
  }

  const stats = calculateStats(batchTimes)
  const totalMs = batchTimes.reduce((a, b) => a + b, 0) * batchSize

  return {
    name,
    iterations,
    totalMs,
    avgMs: stats.avg,
    minMs: stats.min,
    maxMs: stats.max,
    stdDev: stats.stdDev,
    cv: stats.cv
  }
}

function formatResult(result: BenchmarkResult): void {
  console.log(`${result.name}:`)
  console.log(`  Iterations: ${result.iterations.toLocaleString()}`)
  console.log(`  Total time: ${result.totalMs.toFixed(2)}ms`)
  console.log(`  Per call:   ${(result.avgMs * 1000).toFixed(3)}μs`)
  console.log(`  Min:        ${(result.minMs * 1000).toFixed(3)}μs`)
  console.log(`  Max:        ${(result.maxMs * 1000).toFixed(3)}μs`)
  console.log(`  Std Dev:    ${(result.stdDev * 1000).toFixed(3)}μs`)
  console.log(`  CV:         ${result.cv.toFixed(2)}%`)
  console.log()
}

function main(): void {
  console.log("=== @qualithm/device Benchmarks ===\n")
  console.log(`Warmup iterations: ${String(config.warmupIterations)}`)
  console.log(`Benchmark iterations: ${config.benchmarkIterations.toLocaleString()}\n`)

  const results: BenchmarkResult[] = []

  // Benchmark credential serialization (the persistence hot path)
  const serializeResult = runBenchmark(
    "credential serialize",
    () => {
      JSON.stringify(sampleCredential)
    },
    config.benchmarkIterations,
    config.warmupIterations
  )
  results.push(serializeResult)
  formatResult(serializeResult)

  // Benchmark credential parse (read on every boot)
  const parseResult = runBenchmark(
    "credential parse",
    () => {
      JSON.parse(sampleSerialized)
    },
    config.benchmarkIterations,
    config.warmupIterations
  )
  results.push(parseResult)
  formatResult(parseResult)

  // Benchmark Device construction
  const constructResult = runBenchmark(
    "device construct",
    () => {
      new Device(deviceOptions)
    },
    config.benchmarkIterations,
    config.warmupIterations
  )
  results.push(constructResult)
  formatResult(constructResult)

  // Summary
  console.log("=== Summary ===")
  console.log("Benchmark".padEnd(25) + "Avg (μs)".padStart(12) + "CV (%)".padStart(10))
  console.log("-".repeat(47))
  for (const r of results) {
    console.log(
      r.name.padEnd(25) + (r.avgMs * 1000).toFixed(3).padStart(12) + r.cv.toFixed(2).padStart(10)
    )
  }

  console.log("\nBenchmarks complete.")
}

main()
