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
