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

const MAX_CAUSE_DEPTH = 5

/** A primitive cause as text; an object cause has no useful message, so it is skipped. */
function causeText(cause: unknown): string {
  return typeof cause === "string" || typeof cause === "number" ? String(cause) : ""
}

/**
 * Join an error's message with the messages of its `cause` chain, e.g.
 * `Failed to connect to the gateway: unable to get local issuer certificate`.
 */
export function describeError(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)]
  let cause = error instanceof Error ? error.cause : undefined
  for (let depth = 0; cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH; depth++) {
    const message = cause instanceof Error ? cause.message : causeText(cause)
    if (message !== "" && !parts.includes(message)) {
      parts.push(message)
    }
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return parts.join(": ")
}

/** Print an error and its cause chain: a JSON line in `--json` mode, else `Error: <message>`. */
export function printError(json: boolean, error: unknown): void {
  const message = describeError(error)
  if (json) {
    console.error(JSON.stringify({ error: message }))
    return
  }
  console.error(`Error: ${message}`)
}
