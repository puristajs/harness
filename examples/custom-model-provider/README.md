# Custom model provider example

This example maps a small application-owned JSON generation client to
`BaseModelProvider`, registers the provider in a Harness model alias, and runs
one typed agent without a network dependency.

```bash
npm install
npm run typecheck
npm run test
npm run build
npm run start
```

Expected output:

```text
Invoice INV-42 is ready for payment.
```

`src/internalModelProvider.ts` is the adapter boundary. Production adapters
replace `InternalJsonClient` with their SDK or HTTP client, normalize provider
usage and finish reasons, forward cancellation, and keep raw content out of
logs and telemetry. The shared provider contract and application test remain
offline and deterministic.
