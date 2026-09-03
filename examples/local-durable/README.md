# Local durable execution

This example runs a workflow with the local durable storage, workspace, and
sandbox adapters. It simulates a process failure after the first durable step,
starts a fresh Harness instance, and resumes the same run without repeating the
completed step.

Install, verify, and run it from this directory:

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

The example writes only to a temporary directory and needs no provider key or
external service. Use provider-backed adapters when several processes need to
share durable state.
