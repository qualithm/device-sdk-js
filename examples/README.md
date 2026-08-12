# Examples

Runnable examples demonstrating `@qualithm/device` usage.

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
