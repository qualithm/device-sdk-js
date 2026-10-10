# Examples

Runnable examples demonstrating `@qualithm/device` usage.

## Environment Variables

All are optional. `basic-usage.ts` reads all three; `softap-provisioning.ts` reads `QUALITHM_API`.

| Variable              | Description                                                                              | Default                    |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| `QUALITHM_CLAIM_CODE` | Claim code to exchange for a device credential. Unset, the example stops before claiming | None                       |
| `QUALITHM_API`        | Provisioning API base URL. Set it for a claim code from a non-production environment     | `https://api.qualithm.com` |
| `QUALITHM_GATEWAY`    | Gateway host to connect to instead of the one in the claim response                      | None                       |

## Running Examples

```bash
bun run examples/basic-usage.ts
bun run examples/error-handling.ts
bun run examples/credential-persistence.ts
bun run examples/softap-provisioning.ts
```

## Example Files

| File                                                   | Description                                            |
| ------------------------------------------------------ | ------------------------------------------------------ |
| [basic-usage.ts](basic-usage.ts)                       | Configure a device, generate a CSR, claim + connect    |
| [error-handling.ts](error-handling.ts)                 | Typed error hierarchy and `isError()` narrowing        |
| [credential-persistence.ts](credential-persistence.ts) | Crash-safe file store; reuse the credential on restart |
| [softap-provisioning.ts](softap-provisioning.ts)       | Serve the claim exchange on the device's setup network |
