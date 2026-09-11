# Custom sandbox adapter example

This example implements the public `Sandbox` lifecycle as a filesystem-only
adapter, uses it from a typed tool, and runs the shared sandbox contract.

```bash
npm install
npm run typecheck
npm run test
npm run build
npm run start
```

Expected output:

```text
report ready (created: 1, terminated: 1)
```

The example delegates storage to `inMemorySandbox()` so it remains offline. It
teaches the public owner/open/terminate/session contract; it does not claim
container, VM, network, process, or tenant isolation. A production adapter
replaces the delegate with its provider client and verifies those guarantees
with provider-level tests.
