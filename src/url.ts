import { EnrollError, RenewalError } from "./errors.js"
import type { DeviceCredential } from "./types.js"

/**
 * `value` without its trailing slashes. A loop, not `/\/+$/`, which backtracks polynomially on a
 * long run of slashes.
 *
 * @param value - a base URL
 * @returns the URL with no trailing `/`
 */
export function trimTrailingSlash(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1
  }
  return value.slice(0, end)
}

/**
 * Read the `apiUrl` a provisioning response carries: the base URL of the device's zone API. The
 * device sends its credential there, so only an https origin is accepted, with no userinfo, path,
 * query or fragment, and not port 0. Anything else, a local `http` URL included, is ignored like a
 * missing value.
 *
 * @param value - The response's `data.apiUrl`
 * @returns The origin, `https://host[:port]`, or `undefined` when absent or not an https origin
 */
export function parseApiUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  // The serialized URL shows any userinfo, path, query or fragment, even an empty `?` or `#`.
  if (url.protocol !== "https:" || url.href !== `${url.origin}/` || url.port === "0") {
    return undefined
  }
  return url.origin
}

type RequestError = RenewalError | EnrollError

const isRequestError = (error: unknown): error is RequestError =>
  RenewalError.isError(error) || EnrollError.isError(error)

/**
 * True when renewal or enrollment got no HTTP response, which both report as an error with a cause
 * and no status, or a server error (5xx), as an edge in front of an unreachable zone answers.
 */
const missed = (error: unknown): error is RequestError =>
  isRequestError(error) &&
  (error.status === undefined ? error.cause !== undefined : error.status >= 500)

/** What went wrong at `url`, for an error message. */
const missDescription = (error: RequestError, url: string): string =>
  error.status === undefined ? `no response from ${url}` : `${url} answered ${String(error.status)}`

/** A new error of `kind`'s class, so the caller still tells a renewal from an enrollment. */
const sameKind = (
  kind: RequestError,
  message: string,
  options: ErrorOptions & { status?: number }
): RequestError =>
  RenewalError.isError(kind)
    ? new RenewalError(message, options)
    : new EnrollError(message, options)

/**
 * Run a provisioning request at the API URL the platform named for the device's zone, or at
 * `provisioningUrl` when the credential names none or names that same origin. A request that gets
 * no HTTP response or a server error (5xx) at the named URL is tried once more at
 * `provisioningUrl`, which forwards it to the device's zone. Any other HTTP status ends the attempt.
 *
 * @param provisioningUrl - The configured provisioning API base URL
 * @param credential - The stored credential, with the `apiUrl` it learned
 * @param request - The request, run against a base URL
 * @param onFallback - Told of the miss at the named URL when `provisioningUrl` then answers
 * @returns What the request resolves to
 * @throws What the request throws, when only one URL was tried. When both were, an error of the
 *   same class with the last failure's status, and both failures in an `AggregateError` cause
 */
export async function atApiUrl<T>(
  provisioningUrl: string,
  credential: DeviceCredential,
  request: (baseUrl: string) => Promise<T>,
  onFallback?: (failure: Error) => void
): Promise<T> {
  const learned = parseApiUrl(credential.apiUrl)
  const configured = parseApiUrl(provisioningUrl) ?? trimTrailingSlash(provisioningUrl)
  if (learned === undefined || learned === configured) {
    return request(provisioningUrl)
  }
  let miss: RequestError
  try {
    return await request(learned)
  } catch (error) {
    if (!missed(error)) {
      throw error
    }
    miss = error
  }
  const what = missDescription(miss, learned)
  let result: T
  try {
    result = await request(provisioningUrl)
  } catch (error) {
    const status = isRequestError(error) ? error.status : undefined
    const reason = error instanceof Error ? error.message : String(error)
    throw sameKind(miss, `${what}, then at provisioningUrl: ${reason}`, {
      cause: new AggregateError([miss, error]),
      ...(status !== undefined && { status })
    })
  }
  onFallback?.(sameKind(miss, `${what}: provisioningUrl answered instead`, { cause: miss }))
  return result
}
