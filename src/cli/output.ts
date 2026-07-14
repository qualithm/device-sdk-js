/**
 * Dual-mode output for the `qualithm-device` CLI: human-readable by default,
 * or a single JSON line with `--json` for scripting.
 */

/** Print a command's result: a JSON line in `--json` mode, else `human`. */
export function printResult(json: boolean, human: string, data: unknown): void {
  if (json) {
    console.log(JSON.stringify(data))
    return
  }
  console.log(human)
}

/** Print an error: a JSON line in `--json` mode, else `Error: <message>`. */
export function printError(json: boolean, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) {
    console.error(JSON.stringify({ error: message }))
    return
  }
  console.error(`Error: ${message}`)
}
