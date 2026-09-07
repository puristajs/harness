# Local durable execution

This example combines the local durable storage, workspace, and sandbox adapters. A workflow commits an outline step, pauses on a persisted external review wait, then a fresh Harness instance resumes the same run after the application signals approval.

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

The example writes only to a temporary directory and needs no provider key or external service. `localDurableExecution(...)` is intended for development and one trusted host. Use provider-backed storage, sandbox, and workspace adapters when several workers share durable state.
