# Sandbox and durable workspace

Agents and tools declare only the capabilities they need. The application binds a matching sandbox:

```ts
const instance = await definition.getInstance({
  sandbox: dockerSandbox({ root: '/var/lib/app/sandboxes', image }),
})
```

Use the in-memory sandbox for hermetic tests and trusted local demonstrations. Use Docker or Kubernetes for isolated execution. Treat runtime metadata as an allowlisted capability, not an installation request.

A `DurableWorkspace` persists checkpointed files independently from a live sandbox. `localDurableExecution({ root, exec })` returns matching storage, sandbox, and workspace adapters for one trusted host. It is not a distributed production backend.

The application owns sandbox administration, owner registration, cleanup, retention, and offboarding. Never expose provider references, filesystem content, or credentials in logs and telemetry.
