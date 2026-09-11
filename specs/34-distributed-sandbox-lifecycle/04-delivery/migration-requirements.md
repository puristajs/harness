# Clean-break delivery requirements

This is an intentional in-place replacement with one lifecycle-aware contract,
not a migration framework or a compatibility release. The filename is retained
for the specification registry; no migration runtime, converter, dual-read
path, or old/new adapter wrapper is part of this work.

## One contract everywhere

- `Sandbox.open(...)` accepts `SandboxOpenOptions` and returns
  `SandboxOpenResult`; `Sandbox.terminate(...)` is required. No legacy overload,
  alternate managed method, wrapper, or compatibility shim is added.
- `SandboxSession.close()` means detach, not logical termination.
- No runtime multi-instance capability, topology option, or business-logic
  branch is introduced. Distributed behavior is an adapter implementation and
  release-conformance concern.
- Existing `sandbox.snapshot`, `sandbox.resume`, and `sandbox.hibernate`
  capabilities retain their meanings and do not imply distributed coordination
  or durable recovery.
  Their session parameters/results use `SandboxSessionBase`; optional resume
  replaces the incomplete session/run pair with the existing full `SandboxScope`.
  It does not bypass the target's normal attach/detach/terminate lifecycle.
- `HarnessStorage`, including in-memory and SQLite implementations, receives no
  sandbox lifecycle methods or migration. Its session contract gains immutable
  `instanceId`, explicit insert/update intent, and conditional deletion to stop
  stale session handles from adopting or recreating a replacement conversation.
- Existing `DurableWorkspace` public types remain unchanged; implementation
  reuses its approved resume-before-binding ordering.
- Rewrite local in-memory, bash, and both files-only/exec-enabled
  local-directory implementations to the same lifecycle interface. Their
  process-local/single-host authority and existing capability distinctions stay
  explicit; do not force optional exec/snapshot/spawn features onto all adapters.
- Canonical specs 04, 05, 11, 13, 14, 15, 16, 21, 22, and 32 are reconciled for
  the shared identity, lifecycle, type, error, telemetry, and recovery contracts.
  Sandbox coordination remains outside HarnessStorage.
- PURISTA integration is a separate ticket and repository boundary. Harness
  contract work must pass standalone tests before PURISTA changes begin.
- A production provider package, provider-specific example, or handbook setup
  page is prohibited until the bake-off decision is approved.
- The separately approved local Docker addon and its standalone example are
  not production-provider selection. They wait for the shared contract, not
  the E2B/Daytona decision, and do not alter built-in sandbox defaults.
- Roll back the coordinated code/package change as a unit, never by shipping a
  fallback branch. Do not infer permission to delete persisted files or reset
  sessions from a code rollback. Normal versioning applies to the breaking API.

## Required update inventory

Inspected at `c378607de9e7`. These are source-update requirements, not just
tests or documentation requirements. Paths are relative to `ai-harness`.

| Surface | Required replacement | Verification |
| --- | --- | --- |
| `packages/harness/src/sandbox/index.ts` | `Sandbox`, `inMemorySandbox`, `bashSandbox`, and `autoDetectSandbox` use the new lifecycle; remove old `open` arguments/result | Shared lifecycle suite and positive/negative type tests |
| `packages/harness/src/local/local-sandbox.ts` | Both local-directory variants implement open, detach, and terminate directly | Files-only and exec-enabled lifecycle, path-jail, process cleanup, persistence, and failure tests |
| `packages/harness/src/local/index.ts` and existing `local-workspace.ts` binding | Preserve `{ storage, sandbox, workspace, close }`; keep the new sandbox bound to the same active durable workspace | `local-durable-execution.test.ts` checkpoint/resume and shutdown tests |
| `packages/harness/src/testing/{fakeSandbox,sandboxSnapshot,sandboxContract,index}.ts` | Update `FakeSandbox`, `fakeSnapshotSandbox`, both existing shared suites, and exports in place; no legacy fake | Testing-helper, snapshot, and export tests |
| `packages/harness/src/sessions/index.ts`, `runtime/sessionDurable.ts`, and `harness/defineHarness.ts` | Replace initial-session, durable-run, initial/continuation child-task open calls and lifecycle wiring | Session, durable-run, child-task, cancellation, and shutdown tests |
| `packages/harness/src/storage/{types,in-memory,sqlite}.ts` and storage testing helpers | Persist immutable session incarnation; explicit create/update and conditional deletion; no sandbox lifecycle records | Shared storage contract, independent SQLite clients, stale session facade and late-write tests |
| Harness tests and type tests | Update `TrackingSandbox`, inline Sandbox objects, direct open callers, and lifecycle assertions | Full package test/type/build suite; no omitted files or suppressed errors |
| Existing addon/example callers, README/docs, and canonical Harness skill | Update affected public snippets and callers, removing contradictory old lifecycle guidance | Workspace builds/tests and source/doc review |
| PURISTA Core integration and its tests/docs/skill | Consume only the new public Harness contract after standalone conformance | PURISTA integration and dependency checks |

## Local state and recovery

- Within its declared authority, each adapter retains logical files across
  detach and attach. In-memory/Bash adapters may lose everything on process
  loss; attach then reports state loss instead of first-use creation.
- The host-directory adapter uses the complete new scope, not an arbitrary
  `init_<id>` or prior per-open run path. Persisted metadata distinguishes
  first use, termination, loss, and unavailable state. Preserve path-jail and
  tenant/principal isolation checks in both variants.
- Pre-existing directories without matching lifecycle metadata are not proof
  of an existing new-contract scope. Do not adopt, rewrite, delete, or silently
  empty them. Attach reports missing lifecycle state; only the normal committed
  workspace recovery path can authorize restoration. There is no automatic
  old-layout converter, path fallback, or data reset.
- `localDurableExecution` keeps its existing committed-checkpoint recovery
  guarantee. Docker's initially unsupported workspace recovery must not become
  a reason to remove recovery from the existing local bundle.
- Sandbox termination removes only sandbox-owned resources. Workspace
  checkpoints and their retention/cleanup stay with `DurableWorkspace`;
  sharing an active directory does not transfer deletion ownership.

## Acceptance — ACC-SBX-CLEAN-BREAK

One coordinated Harness integration must pass before the changed package is
merged/released or consumed by downstream implementation. A new type with an
old adapter, fake, caller, or `.close()` meaning is not a completed increment.

- Base lifecycle conformance covers all existing factories and test doubles,
  including both local-directory variants. Supported recovery succeeds;
  unsupported recovery fails explicitly without side effects. Do not weaken
  optional capability suites or manufacture success to make a fixture pass.
- Negative type tests reject `open({ sessionId, runId })`, a bare session as an
  `open` result, and adapters missing `terminate`. Invalid old-shaped runtime
  inputs fail validation before side effects, without translating them.
- No `LegacySandbox`, `SandboxV2`, compatibility flag, optional termination
  fallback, duplicate lifecycle type, transitional overload, or old/new branch
  remains. Type casts, `any`, ignored errors, excluded files, and skipped tests
  must not conceal an incomplete replacement.
- The new common contract and its source-derived types are reused. Existing
  optional snapshot/resume/hibernate interfaces are capability extensions,
  not legacy interfaces, and are retained without duplicate open contracts.
- Run the full Harness and workspace verification envelope, plus a semantic
  inventory of Sandbox implementations and open/close callers in code, tests,
  examples, docs, and skills. Text search is discovery, not sufficient proof.
  Deliberate negative type tests and clearly historical research may retain
  old syntax; active instructions and executable callers may not.

These checks extend `REQ-SBX-CONTRACT` / `CAP-SBX-CONTRACT` /
`PATH-SBX-CONTRACT`; they introduce no new runtime concept or dependency.
