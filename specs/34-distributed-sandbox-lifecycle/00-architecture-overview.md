# Architecture overview

```text
application or PURISTA integration
  -> public @purista/harness session/run API
     -> Sandbox lifecycle port (one interface)
        - adapter-owned logical directory and lifecycle state
        - generations, leases, fencing, opaque provider references
        - retention, termination, cleanup, orphan reclamation
        - direct provider SDK and/or adapter-owned control plane
     -> DurableWorkspace (optional, separate public port)
        - committed replayable files for authorized recovery
     -> HarnessStorage (session integrity strengthened)
        - sessions, messages, runs, checkpoints, waits, events
```

Harness owns provider-neutral scope construction, call ordering, recovery
authorization, typed errors, capability projection, and standard telemetry.
The sandbox adapter is the source of truth for live compute and all distributed
sandbox coordination. `DurableWorkspace` is the source of truth for files that
must survive compute loss. `HarnessStorage` does not store sandbox generations,
leases, fences, or provider references.

An external `@purista/harness-sandbox-*` package depends only on the public
`@purista/harness` surface and its provider SDK or private control-plane client.
A provider bundle may construct compatible `Sandbox` and `DurableWorkspace`
ports that share private backend state, while both ports stay independently
testable and preserve their public contracts.

PURISTA Core may depend on public `@purista/harness` APIs and compose those
ports under the hood. The dependency direction never reverses: Harness core,
Harness addons, and provider packages do not import `@purista/core`, event-bus
messages, service builders, or PURISTA runtime internals.

Every adapter implements the same open/detach/terminate lifecycle. Harness and
PURISTA never inspect adapter topology or branch on its deployment model.
Production adapter packages prove shared-state and stale-mutation safety in
their adapter contract tests; local development/test adapters document their
process or host authority. Core never reconstructs provider handles, renews
provider leases, runs cleanup batches, or calls a provider SDK.
