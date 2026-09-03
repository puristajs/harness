# Non-functional requirements

## Security and isolation

- Core compares exact optional `HarnessIdentity` before sandbox access.
  Standalone Harness supports single-tenant/no-identity use; integrations may
  require tenant and principal as application policy.
- The adapter or its control plane validates logical scope and current
  attachment authority on every mutation. A production distributed adapter
  enforces this at the shared provider/control-plane boundary.
- Invalid open modes and termination reasons fail before lifecycle mutation.
  Local storage errors are normalized without native filesystem messages,
  causes, or host paths. Cancellation is rechecked after asynchronous path
  resolution immediately before allocating a child process.
- Provider tags and names never contain raw tenant, principal, session, run,
  prompt, path, or secret values.
- Provider references and credentials remain adapter-private. Credentials are
  composition-root configuration and never enter public results.
- Provider packages document egress, unprivileged identity, CPU/memory/PID/disk
  limits, image provenance, secret injection, isolation, and secure cleanup.
  These are bake-off criteria, not implied by the core port.

## Integrity, concurrency, and recovery

- Every adapter passes the base lifecycle contract. Every production
  distributed adapter also passes the multi-client contract: two independent
  clients create at most one provider generation for concurrent first open of
  a logical scope.
- Create mode is valid only for a newly allocated scope. Attach mode never
  creates missing state, including when a process-local adapter is reopened
  against durable Harness storage after losing its volatile directory.
- An attachment that loses authority cannot mutate compute. The adapter may use
  leases and fencing internally; Harness does not prescribe the algorithm or
  configuration fields.
- Authoritative not-found is distinct from provider unavailable. Only
  authoritative absence creates adapter-private `lost` state.
- `DurableWorkspace` files are the recovery guarantee. No sandbox snapshot,
  sticky route, host path, provider process, or attachment handle substitutes
  for a committed workspace checkpoint.
- Authorized recovery creates one next generation and never changes the
  logical scope. An identical retry is idempotent.
  Local workspace binding carries the resume idempotency key privately;
  repeated opens for that binding retain the restored generation. The host
  directory adapter supports one active process per root, not cross-process
  concurrent ownership. Its operation queues coordinate clients within that
  process; Docker separately enforces host ownership.
- A local active workspace has one full-scope owner claim outside guest files
  and checkpoints. A different identity, incarnation, role, harness, or metadata
  root cannot adopt that workspace; missing ownership fails closed.
- `SandboxSession.close()` is idempotent detach and invalidates
  attachment-local handles without terminating logical compute.
- Explicit termination is idempotent. The adapter completes cleanup before
  acknowledging, or records pending cleanup within its declared lifecycle
  authority before acknowledging when provider cleanup is asynchronous.
- Close invalidates attachment handles before awaiting cleanup. Process
  admission rechecks that authority after asynchronous preparation; a child
  cannot start after successful close. Termination can stop an active command
  without waiting for that command to finish naturally.
- Cleanup failures after a committed terminal run do not change its business
  outcome or make it resumable. Emit normalized content-free warnings and
  preserve adapter/operator cleanup retries; add no core maintenance loop.
- Adapter retention must preserve enough directory/tombstone information to
  distinguish first use, explicit termination, loss, and temporary outage. A
  terminated scope may compact to a derived content-free tombstone but never
  becomes first-use again; a new SessionRecord has a different
  `sessionInstanceId` scope.

## Telemetry

- Harness emits short `harness.sandbox.open`, `harness.sandbox.detach`, and
  `harness.sandbox.terminate` spans for normal Sandbox lifecycle operations.
- Two metrics are sufficient: `harness.sandbox.operations` (counter) and
  `harness.sandbox.operation.duration` (seconds histogram). Attributes are
  limited to operation, adapter id, disposition when applicable, status,
  live-process outcome, and normalized `error.type`.
- Metrics never contain scope values, provider refs, generations, leases,
  fences, checkpoints, paths, commands, content, or credentials.
- Logs and spans also exclude provider refs, raw tenant/principal values,
  generations, lease/fence values, checkpoint refs, host paths, commands,
  stdout/stderr, prompts, tool data, credentials, signed URLs, and provider
  response bodies.
- Existing trace/run/session context provides correlation. No new lifecycle
  correlation identifier is introduced.
- Provider adapters may add provider-specific child spans but must not duplicate
  standard Harness spans or weaken redaction.

## Performance and resilience

- Contract tests use deterministic virtual time or explicit coordination hooks;
  core does not sleep or renew leases.
- Sandbox lifecycle calls honor caller cancellation. Provider timeouts and retry policy
  are adapter configuration.
- The provider bake-off reports p50, p95, and p99 for create, attach,
  hibernate/resume where supported, restore, and terminate under identical
  region/resource settings. This spec sets no provider-independent latency SLO.
- Cleanup backlog, cost distribution, and orphan handling are adapter
  operational evidence, not Harness metrics or APIs.

## Verification

- Unit and type tests cover scope construction, identity presence/value
  matching, lifetime/run rules, create/attach/restore selection, capability
  projection, and recovery call order.
- `sandboxContract` covers lifecycle behavior for every adapter. The shared
  `sandboxMultiClientContract` covers two clients, concurrent first open,
  handoff, stale
  mutation denial, provider loss versus outage, authorized recovery,
  termination, cancellation, and privacy.
- Harness and PURISTA runtime tests contain no topology capability check or
  local-versus-distributed business-logic branch.
- Harness integration tests use a fake remote adapter plus existing in-memory
  `DurableWorkspace`; no HarnessStorage lifecycle fake is added.
- PURISTA tests prove public-contract-only composition and identity projection.
- The opt-in `npm run verify:sandbox-packages` gate builds and installs actual
  Harness/Docker tarballs into an isolated temporary consumer. It verifies
  runtime behavior, capability-inferred declarations, absence of Framework,
  and inaccessible private subpaths without source aliases or symlinks.
  Cached dependency installation is not a registry publication claim.
- Live provider tests are opt-in, credential-gated, non-production, and sanitize
  persisted evidence.
