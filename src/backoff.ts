/**
 * Reconnect backoff (qualithm/pm#2162): exponential growth with full jitter,
 * so a fleet refused by the gateway spreads its retries out instead of
 * retrying in lockstep every second.
 */

/** The longest wait between reconnect attempts, in milliseconds. */
export const RECONNECT_CAP_MS = 30_000

/** The shortest wait, so a zero jitter draw never hot-loops. */
export const RECONNECT_FLOOR_MS = 100

/**
 * The wait before the next reconnect after `attempt` consecutive failures:
 * a uniform draw from `[0, min(cap, base · 2^(attempt − 1)))`, at least
 * {@link RECONNECT_FLOOR_MS}. Reset `attempt` to 0 once a connect is accepted.
 *
 * @param attempt - Consecutive failed attempts so far (1 for the first)
 * @param base - The ceiling of the first wait, in milliseconds
 * @param cap - The largest ceiling, in milliseconds
 * @param random - Source of uniform draws in `[0, 1)`
 */
export const reconnectDelay = (
  attempt: number,
  base: number,
  cap: number = RECONNECT_CAP_MS,
  random: () => number = Math.random
): number => {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return Math.max(RECONNECT_FLOOR_MS, Math.floor(random() * ceiling))
}
