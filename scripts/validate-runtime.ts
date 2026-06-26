#!/usr/bin/env bun
/**
 * Cross-runtime validation script.
 *
 * Tests that the library can be imported and used correctly across
 * different JavaScript runtimes (Bun, Node.js, Deno).
 *
 * Run with: bun run scripts/validate-runtime.ts
 */

import { spawn } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

// ── Test Code ─────────────────────────────────────────────────────────

function getTestCode(importPath: string): string {
  return `
import { Device, createMemoryCredentialStore } from "${importPath}";

let passed = 0;
let failed = 0;

// Check the primary export is a constructor
if (typeof Device === "function") {
  passed++;
} else {
  failed++;
  console.error("FAIL: Device is not a constructor");
}

// Exercise the in-memory credential store round-trip (no network needed)
try {
  const store = createMemoryCredentialStore();
  const credential = {
    deviceId: "11111111-1111-1111-1111-111111111111",
    teamId: "t",
    spaceId: "s",
    kind: "token",
    token: "qmd_smoke",
    issuedAt: new Date().toISOString()
  };
  await store.save(credential);
  const loaded = await store.load();
  if (loaded && loaded.token === "qmd_smoke") {
    passed++;
  } else {
    failed++;
    console.error("FAIL: credential store round-trip returned:", loaded);
  }
} catch (error) {
  failed++;
  console.error("FAIL: credential store threw:", error);
}

console.log(\`Passed: \${passed}, Failed: \${failed}\`);
process.exit(failed > 0 ? 1 : 0);
`.trim()
}

// ── Runtime Detection ─────────────────────────────────────────────────

type RuntimeInfo = {
  name: string
  command: string
  args: string[]
  available: boolean
  version?: string
}

async function checkRuntime(
  name: string,
  command: string,
  versionArg: string
): Promise<RuntimeInfo> {
  return new Promise((resolve) => {
    const proc = spawn(command, [versionArg], { stdio: ["ignore", "pipe", "ignore"] })
    let version = ""

    proc.stdout.on("data", (data: Buffer) => {
      version += data.toString()
    })

    proc.on("error", () => {
      resolve({ name, command, args: [], available: false })
    })

    proc.on("close", (code) => {
      resolve({
        name,
        command,
        args: [],
        available: code === 0,
        version: version.trim().split("\n")[0]
      })
    })
  })
}

// ── Test Runner ───────────────────────────────────────────────────────

async function runTest(
  runtime: RuntimeInfo,
  testFile: string
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [...runtime.args]
    args.push(testFile)

    // Run from the package root so every runtime (including Deno) resolves the
    // SDK's npm dependencies from ./node_modules.
    const proc = spawn(runtime.command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString()
    })
    proc.stderr.on("data", (data: Buffer) => {
      output += data.toString()
    })

    proc.on("error", (error) => {
      resolve({ success: false, output: error.message })
    })

    proc.on("close", (code) => {
      resolve({ success: code === 0, output: output.trim() })
    })
  })
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Cross-Runtime Validation")
  console.log("========================\n")

  // Check available runtimes
  const runtimes: RuntimeInfo[] = await Promise.all([
    checkRuntime("Bun", "bun", "--version").then((r) => ({ ...r, args: ["run"] })),
    checkRuntime("Node.js", "node", "--version").then((r) => ({
      ...r,
      args: ["--experimental-vm-modules"]
    })),
    checkRuntime("Deno", "deno", "--version").then((r) => ({
      ...r,
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "--node-modules-dir=auto",
        "--no-lock"
      ]
    }))
  ])

  console.log("Available runtimes:")
  for (const runtime of runtimes) {
    const status = runtime.available ? `✓ ${runtime.version ?? "unknown"}` : "✗ not found"
    console.log(`  ${runtime.name}: ${status}`)
  }
  console.log()

  const available = runtimes.filter((r) => r.available)
  if (available.length === 0) {
    console.error("No runtimes available for testing")
    process.exit(1)
  }

  // Write the smoke test into the package root so every runtime resolves the
  // SDK's npm dependencies from ./node_modules.
  const testFile = join(process.cwd(), ".runtime-check.mjs")

  try {
    await writeFile(testFile, getTestCode("./dist/index.js"))

    // Run tests
    console.log("Running validation tests:")
    console.log("-".repeat(40))

    let passed = 0
    let failed = 0

    for (const runtime of available) {
      process.stdout.write(`${runtime.name}: `)
      const result = await runTest(runtime, testFile)

      if (result.success) {
        console.log("✓ PASS")
        passed++
      } else {
        console.log("✗ FAIL")
        console.log(`  Output: ${result.output}`)
        failed++
      }
    }

    console.log("-".repeat(40))
    console.log()
    console.log(`Results: ${String(passed)} passed, ${String(failed)} failed`)
    console.log()

    if (failed > 0) {
      process.exit(1)
    }
  } finally {
    // Cleanup
    await rm(testFile, { force: true })
  }
}

main().catch((error: unknown) => {
  console.error("Validation failed:", error)
  process.exit(1)
})
