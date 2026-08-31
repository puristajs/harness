# Custom memory engine example

This example maps an application-owned key/value client to the Harness
`MemoryEngine` port, uses it through session-scoped memory, and runs the shared
memory contract suite.

```bash
npm run typecheck --workspace @purista/custom-memory-engine-example
npm run test --workspace @purista/custom-memory-engine-example
npm run build --workspace @purista/custom-memory-engine-example
npm run start --workspace @purista/custom-memory-engine-example
```

Expected output:

```text
open
```

The included map client is an offline fixture and does not advertise
`memory.persistent` or `memory.multi_instance`. A production adapter replaces
that client with its database SDK and advertises only guarantees verified by
backend integration tests. The example registers an intentionally unused model
alias because every runnable Harness requires at least one model alias; the
memory-only scenario never calls it.
