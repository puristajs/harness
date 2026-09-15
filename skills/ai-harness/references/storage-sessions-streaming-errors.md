# Storage, sessions, streams, and errors

Use stable session ids for conversation or business boundaries. `run` returns
`completed` or `interrupted`; failures and cancellation throw normalized
Harness errors. `stream` yields `run.started`, typed updates, and one terminal
`run.finished` event whose outcome can also be `failed` or `cancelled`.

```ts
for await (const event of session.agents.assistant.stream(input, { signal })) {
  if (event.type === 'run.finished') handle(event.outcome)
}
```

Harness storage persists sessions, messages, runs, events, checkpoints, leases, and external waits. Memory stores scoped facts and search data. Finalization removes durable checkpoints after a terminal outcome.

Use `isHarnessError` and `serializeError` at application boundaries. Route stable code/category/meta fields; do not expose nested causes, provider bodies, prompts, tool values, or policy content. Always cancel abandoned streams and close the instance during shutdown.
