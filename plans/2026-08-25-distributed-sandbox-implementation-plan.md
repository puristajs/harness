# Distributed sandbox implementation plan

Status: local implementation and behavioral verification complete; coverage,
architecture, and isolated packed-package checks pass. Publication and
production-provider work are not included. The 2026-08-26 completion audit
reopened and repaired identity isolation, idempotency, tombstones, stale handles,
process cleanup, and Docker ownership. Evidence and remaining release limits:
`2026-08-26-sandbox-completion-audit.md`.

Source: approved `specs/34-distributed-sandbox-lifecycle` manifest. Production
provider work remains blocked until `GATE-SBX-PROVIDER`.

2026-08-26 addition: the owner approved a separate local Docker package,
including OrbStack through the same adapter. `SBX-012` and the available-engine
evidence in `SBX-013` are complete. Untested engines remain unverified.

2026-08-26 clean-break tightening: `SBX-014` explicitly owns the existing
local-directory source rewrite. `SBX-001` through `SBX-004` and `SBX-014`
form one coordinated Harness integration; the update inventory is authoritative
in `04-delivery/migration-requirements.md` under spec 34.

## Planning principles

- Keep `@purista/harness` useful without PURISTA, a remote provider, or a
  distributed storage adapter.
- Extend the existing Sandbox port and runtime paths; do not create a new core
  lifecycle subsystem.
- Rewrite existing adapters and callers directly. No legacy overloads,
  compatibility wrappers, old/new flags, optional-terminate fallbacks, or
  migration runtime. Preserve optional capabilities and existing durable files.
- Keep deployment topology invisible to Harness/PURISTA business logic; no
  runtime multi-instance capability or local/distributed branch is added.
- Keep generations, leases, fencing, provider references, retention, and
  cleanup inside the Sandbox adapter/control plane.
- Reuse `HarnessIdentity`, session binding, `DurableWorkspace`, capability
  projection, errors, telemetry, and contract-test conventions.
- Implement the standalone Harness contract before the PURISTA projection.
- Use one shared provider probe and permit the decision “select none”.
- Ship local Docker as `@purista/harness-sandbox-docker`, outside core, with
  one Docker/OrbStack implementation and no new control-plane service.
- Keep the first Docker slice Sandbox-only. Retained volumes are not committed
  workspace checkpoints; unsupported restore fails explicitly. Compatible
  checkpoint recovery is a follow-up requiring its own approved binding.
- No ticket may add sandbox lifecycle methods to `HarnessStorage`, a Harness
  maintenance API/daemon, provider SDK dependencies to core, or an empty-state
  fallback.

## Gates and dependency graph

- `GATE-SBX-SPEC`: passed. The repository owner auto-approved the current
  manifest-bound contract and plan.
- `GATE-SBX-CONTRACT`: passed for the built-in, local-directory, fake, and
  standalone runtime implementations; the shared distributed contract is a
  fixture proof, not evidence for an unimplemented production provider.
- `GATE-SBX-PROVIDER`: blocked. It passes only after E2B and Daytona evidence is
  reviewed and a provider/control-plane decision is explicitly approved.
- `GATE-SBX-DOCKER-RELEASE`: local verification passed on OrbStack 2.2.3,
  Docker CLI/Engine 29.4.0, macOS 26.5.2 arm64. Package publication and
  fresh-registry consumer installation are not performed. Docker Desktop and
  native Linux require their own evidence before support is claimed. This is
  not a registry publication or certification of untested engines.

```text
SBX-001 -> SBX-002 -> {SBX-003, SBX-014} -> SBX-004 --GATE-SBX-CONTRACT
GATE-SBX-CONTRACT -> SBX-005
SBX-002 -> SBX-006 --GATE-SBX-CONTRACT (live use)--> {SBX-007, SBX-008} -> SBX-009
SBX-004 + SBX-005 + SBX-009 --GATE-SBX-PROVIDER--> SBX-010 -> SBX-011
SBX-004 --GATE-SBX-CONTRACT--> SBX-012 -> SBX-013 --GATE-SBX-DOCKER-RELEASE
```

## Wave 1 — standalone public contract

### SBX-001 — replace the contract and in-memory/Bash implementations

- Status: complete.
- Repository: `ai-harness`.
- Write scope: `packages/harness/src/sandbox/**`, capability catalog, error
  catalog/main exports, `packages/harness/type-tests/**`, and focused
  in-memory/Bash tests. Testing-entrypoint implementations belong to `SBX-002`.
- Deliverable: one `Sandbox` interface using `SandboxScope`, `SandboxOpenMode`,
  `SandboxOpenOptions`, `SandboxOpenResult`, and
  `SandboxTerminateOptions`; plus `sandbox.live_process_preservation` and
  `SandboxStateLostError`, with
  TypeDoc-ready examples, plus direct lifecycle implementations in
  `inMemorySandbox()` and `bashSandbox()` and updated `autoDetectSandbox()`.
- Action plan: read the clean-break inventory and approved contract; write
  failing positive/negative type and factory lifecycle tests; replace the port
  and both factory implementations in place; update exports/capability/error
  projection; run focused tests and stage the exact new-contract types for
  `SBX-002`. Do not add a temporary wrapper to keep old callers compiling.
- Acceptance:
  - there is no `MultiInstanceSandbox`, alternate open/terminate method family,
    topology mode switch, or lifecycle facade;
  - both built-in factories expose the same open/detach/terminate API, retain
    files across detach/attach within their authority, and terminate only the
    requested scope; other implementations have explicit owners below;
  - session/run lifetime validation and exact optional identity are exhaustive;
  - create/attach/restore modes make creation authority explicit; an existing
    persisted scope never falls through to first-use creation;
  - no public capability, option, inspection field, or branch exposes adapter
    topology;
  - no public generation, lease, fence, provider ref, lifecycle policy, or
    maintenance type exists;
  - old-shaped open inputs, bare-session open results, and missing terminate
    are rejected by type tests; malformed requests fail before side effects;
  - final main/testing export snapshots and `npm run test:types` pass at the
    joint `SBX-004` gate, with no exclusions or compatibility branches.

### SBX-002 — add base and distributed-adapter lifecycle contracts

- Status: complete.
- Repository: `ai-harness`.
- Write scope: `packages/harness/src/testing/**`, `test/sandbox.test.ts`,
  `test/sandbox-snapshot.test.ts`, and testing-export assertions in
  `test/public-api.test.ts` under `packages/harness`.
- Deliverable: lifecycle coverage in `sandboxContract`, plus
  `sandboxMultiClientContract` and a deterministic fake backend that
  constructs two independent `Sandbox` clients over shared private state.
  Rewrite existing `FakeSandbox`, `fakeSnapshotSandbox`, and
  `sandboxSnapshotContract` directly; no test-only old API survives.
- Action plan: derive lifecycle/failure cases from the contract before fixture
  changes; update existing shared suites and doubles to return
  `SandboxOpenResult` and implement termination; add the two-client fixture;
  run `npm run test:contracts` plus focused testing/snapshot tests; stage the
  fixtures for the runtime and local-directory tickets.
- Acceptance:
  - every adapter passes create/attach, detach, terminate, state-loss,
    cancellation, and privacy through `sandboxContract`; supported recovery is
    verified and unsupported recovery must fail without mutation, not be faked;
  - concurrent first open creates one generation;
  - handoff keeps the generation and stale mutations fail at the adapter
    boundary;
  - not-found, outage, timeout, quota, unauthorized, and cancellation remain
    distinct;
  - attach never creates; authorized restore creates exactly the next
    generation;
  - detach and terminate are idempotent; private refs/fences never appear in
    public results or telemetry fixtures;
  - existing sandbox and snapshot contracts remain green against the new API;
    optional snapshot APIs are not removed or turned into lifecycle aliases.

## Wave 2 — standalone Harness orchestration

### SBX-003 — integrate sessions, durable runs, and telemetry

- Status: complete.
- Repository: `ai-harness`.
- Write scope: `packages/harness/src/sessions/index.ts`,
  `src/runtime/sessionDurable.ts`, `src/harness/defineHarness.ts`, sandbox
  validation, telemetry catalog/rendering, error mapping, and their focused
  session/durable/child-task tests under `packages/harness`; session identity
  types, in-memory/SQLite session persistence, and shared storage tests are also
  in scope for immutable incarnation and stale-write/deletion prevention. This explicitly
  includes `TrackingSandbox` in `test/session-lifecycle.test.ts` and inline
  Sandbox objects in `test/harness.test.ts`. No new
  `sandbox-lifecycle/` or storage lifecycle module.
- Deliverable: scope construction, lifecycle open, detach/terminate ordering,
  durable recovery authorization, and standard sandbox lifecycle telemetry.
- Action plan: add failing session/run/child-task lifecycle tests; replace all
  four existing open paths (initial session, durable run, initial child task,
  continued child task), consuming `result.session`; update release/close/
  shutdown and test doubles; run lifecycle, durable, child-task, and telemetry
  suites. Remove synthetic initial run identity from ordinary session scopes.
- Acceptance:
  - identity mismatch fails before sandbox access;
  - newly allocated scopes use create, while persisted ordinary sessions use
    attach;
  - durable workflows/child tasks use run scope;
  - workspace resume and spec-21 binding complete before restore mode;
  - failed or missing workspace recovery produces no replacement;
  - `Session.release()` detaches, `Session.close()` gets durable termination
    acceptance before storage deletion, and Harness shutdown does not terminate
    retained logical sandboxes;
  - HarnessStorage gains only immutable session incarnation, explicit
    create/update intent, and conditional deletion; no sandbox lifecycle
    persistence, provider references, or maintenance methods;
  - open/detach/terminate telemetry passes the forbidden-value tests.

### SBX-014 — rewrite the existing local-directory sandbox and bundle

- Status: complete.
- Repository: `ai-harness` only.
- Source: spec-34 clean-break delivery inventory and `ACC-SBX-CLEAN-BREAK`,
  `CTR-SBX-SCOPE`, `CTR-SBX-OPEN`, `CTR-SBX-SANDBOX`; specs 21/22 for the
  unchanged local durable-workspace guarantee.
- Write scope: `packages/harness/src/local/local-sandbox.ts`,
  `src/local/index.ts`, the existing binding hooks in `src/local/local-workspace.ts`
  only where required by the new sandbox lifecycle, and
  `test/local-durable-execution.test.ts`, local lifecycle/workspace-isolation
  tests, and private `src/local/local-sandbox-state.ts` under `packages/harness`.
  No SQLite/HarnessStorage schema, checkpoint-format, Docker, or PURISTA edits.
- Read scope: those paths, the approved contract, shared suites from `SBX-002`,
  public workspace types, and the local-state/cleanup ownership requirements.
- Deliverable: both `FilesOnlyLocalDirectorySandbox` and
  `ExecLocalDirectorySandbox` directly implement the new interface;
  `localDurableExecution` still returns exactly `{ storage, sandbox, workspace,
  close }` with working checkpoint recovery.
- Numbered action plan:
  1. Verify staged contract/fixture prerequisites and baseline local tests;
     reuse the existing base class, path jail, workspace binding, and types.
  2. Add failing tests for both variants: full scope isolation, duplicate create,
     detach/reattach, process restart, missing lifecycle metadata, old unmanaged
     directories, termination retry, and committed workspace restore.
  3. Replace open signatures/results and implement actual detach/terminate
     behavior in the existing local classes. Persist private host lifecycle
     metadata; never derive scope from arbitrary per-open run paths or adopt
     old directories. Keep metadata/coordination out of HarnessStorage.
  4. Update bundle binding and cleanup ordering without changing workspace
     checkpoint ownership or return shape. Termination must not delete retained
     durable checkpoints. Preserve files-only defaults and host-exec restrictions.
  5. Run `npm test --workspace @purista/harness -- test/local-durable-execution.test.ts`
     and staged shared lifecycle tests for both variants; run package typecheck
     and report any integration-only failures to `SBX-003`/`SBX-004` without
     suppressing them. Record evidence against `ACC-SBX-CLEAN-BREAK`,
     `ACC-SBX-RESTORE`, `ACC-SBX-STATE-LOST`, and `ACC-SBX-CLEANUP`.
  6. Review source/tests against the approved inventory and hand off to
     `SBX-004`; no old implementation, converter, or transitional adapter remains.
- Acceptance: actual local source changes and both variant suites are required;
  passing fake-only tests is insufficient. Existing symlink/traversal, timeout,
  cancellation, privacy, durable checkpoint, and cleanup tests remain enabled.
- Autonomy: D0/D1 mechanics only. Reuse `sandbox.logical-scope` and
  `sandbox.open-result`; no new exported lifecycle type or coordinator API.

### SBX-004 — prove standalone behavior and preserve local DX

- Status: complete.
- Repository: `ai-harness`.
- Write scope: existing session/lifecycle tests, remaining sandbox-related
  test/type fixtures and public-export assertions,
  affected addon/example callers, README/docs, and canonical Harness skill
  material. Production adapter/runtime corrections return to their owning
  ticket; this is not an unrestricted source-refactoring ticket.
- Deliverable: a two-Harness-instance fake-remote proof plus concise standalone
  setup, recovery, and lifecycle documentation.
- Action plan: assemble shared conformance for each actual existing factory,
  both local-directory variants, and existing fakes; add failing integration
  cases for `ACC-SBX-CLEAN-BREAK`; replace remaining direct caller/snippet uses;
  verify the inventory and full command envelope; review all staged tickets
  together before setting `GATE-SBX-CONTRACT`.
- Acceptance:
  - release/reattach, owner loss, durable restore, ordinary state loss, close,
    cancellation, and shutdown pass without sticky routing;
  - local/in-memory/bash/local-directory adapters implement the same lifecycle
    methods using process-local or single-host state, require no external
    coordination configuration, and expose no topology signal;
  - docs distinguish durable files from optional live processes and contain no
    provider promise or production provider setup.
  - `ACC-SBX-CLEAN-BREAK` passes across real existing implementations, test
    doubles, callers, active docs, and skills; no old overload/return type,
    optional terminate fallback, wrapper, skipped test, or type suppression
    conceals unfinished replacement;
  - record `npm run lint`, `npm run typecheck`, `npm run test:types`, `npm test`,
    `npm run test:contracts`, `npm run test:integration`, `npm run test:failure`,
    and `npm run build` results. Focused lifecycle/local/snapshot/child-task
    tests also run explicitly; normal test selection includes these suites;
  - complete a semantic search/review of Sandbox implementations and open/close
    callers in `packages`, `examples`, `docs`, and `skills`; permit old syntax
    only in deliberate negative tests or clearly historical research.

## Wave 3 — integration boundary and provider probes

### SBX-005 — project the contract through PURISTA Core

- Status: complete.
- Repository: `purista` only; no Harness source changes unless a public-contract
  defect is first returned to `ai-harness` as a spec issue.
- Write scope: existing AI runtime composition, attached-agent tests, dependency
  checks, public docs, and canonical PURISTA skill projection.
- Deliverable: map authenticated tenant/principal context to `HarnessIdentity`,
  apply application startup requirements, and use the public Harness API under
  the hood.
- Acceptance:
  - dependency direction is PURISTA Core -> public `@purista/harness`;
  - no provider SDK/ref, lease, fence, generation, or Harness internal import;
  - PURISTA runtime code contains no local/distributed capability check or
    topology-specific lifecycle path;
  - missing/mismatched identity follows application policy before sandbox open;
  - state loss, durable recovery, release, termination, and capability startup
    tests pass;
  - PURISTA adds parent service context but no duplicate lifecycle telemetry;
  - relevant PURISTA skills/knowledge audits pass.

### SBX-006 — build one opt-in provider probe

- Status: deferred with provider work; depends on `SBX-002` and `GATE-SBX-CONTRACT` before live use.
- Repository: `ai-harness`, non-published spike/test location only.
- Write scope: one provider-neutral probe, sanitized evidence schema, and
  offline fake-probe tests. No production adapter package.
- Deliverable: executable mapping for all ten approved bake-off criteria using
  runtime-only credentials and identical resource/region inputs.
- Acceptance: persisted evidence contains only pass/fail/unknown, versions,
  timings, costs, safe capability outcomes, and links; it contains no raw ids,
  refs, scopes, commands, output, files, or credentials.

### SBX-007 — run the E2B spike

- Status: deferred with provider work; depends on `SBX-006` and `GATE-SBX-CONTRACT`.
- Repository: `ai-harness` spike/evidence scope only.
- Deliverable: E2B mapping and sanitized evidence from the shared probe.
- Acceptance: no provider-specific relaxation, no published package, and each
  criterion is pass/fail/unknown with current primary-source/API evidence.

### SBX-008 — run the Daytona spike

- Status: deferred with provider work; depends on `SBX-006` and `GATE-SBX-CONTRACT`; parallel with `SBX-007`.
- Repository, deliverable, and acceptance: identical to `SBX-007` for Daytona.

### SBX-009 — make the provider/control-plane decision

- Status: deferred with provider work; depends on `SBX-007` and `SBX-008`.
- Repositories: specs/plans only.
- Deliverable: one comparison report covering direct-SDK viability, minimum
  control-plane needs, security/operations/cost risks, and a recommendation
  that may select E2B, Daytona, or none.
- Acceptance: independent evidence review plus explicit D3 owner approval sets
  `GATE-SBX-PROVIDER`; until then `SBX-010` and `SBX-011` stay blocked.

## Local Docker track — independent of production provider selection

Slice strategy: one standalone local execution increment, followed by real
engine compatibility/release proof. These tickets use the same contract as all
other adapters. They do not depend on PURISTA integration or provider probes.

### SBX-012 — implement the optional local Docker package

- Status: complete; 41 hermetic/shared tests plus typecheck/build pass.
  Real-engine evidence and limits are recorded under `SBX-013`.
- Repository: `ai-harness`.
- Spec/decision: `05-integration/local-docker.md`, `CTR-SBX-DOCKER`, and
  `DEC-SBX-DOCKER` under spec 34.
- Traceability: `REQ-SBX-DOCKER`, `CAP-SBX-DOCKER`, `PATH-SBX-DOCKER`,
  `PATH-SBX-DOCKER-LOSS`, `ACC-SBX-DOCKER`, `ACC-SBX-DOCKER-LOSS`.
- Write scope: `packages/harness-sandbox-docker/**` and package registration in
  the root lockfile only. No Harness/PURISTA source or default-factory changes.
- Read scope: the cited spec, representation/generation maps, public Harness
  sandbox/errors/context exports, shared testing contracts, and an existing
  addon's package/build conventions. Internal local-workspace code is not a
  reuse dependency.
- Deliverable: `dockerSandbox(options)` returning the existing Sandbox port,
  with private Docker CLI transport, scoped containers/volumes, host lifecycle
  metadata, no cloud dependency, and no separate OrbStack implementation.
- Action plan / test-first order:
  1. Verify prerequisite contract evidence and the approved spec digest; stop
     for any missing public contract instead of importing Harness internals.
  2. Derive closed option validation/types from `CTR-SBX-DOCKER`, reuse
     `sandbox.logical-scope` and `sandbox.open-result`, and add type/export
     tests. Handwritten mapping is authorized by the generation map; no new
     generator or duplicated lifecycle types.
  3. Add failing shared lifecycle and private transport tests for configuration,
     FS/exec/spawn, create/attach/detach/terminate, guest-process cancellation,
     same-host ownership, partial cleanup, unsupported restore, and redaction.
  4. Implement only that mapping with fixed argument arrays, pinned engine
     context, guest security/resource policy, private ownership checks, and
     exact-resource cleanup. Never use host exec fallback, raw Docker flags,
     global prune, automatic image pulls, or lease takeover without stopping
     old guest work.
  5. Run package `lint`, `typecheck`, `test`, and `build` via npm workspace
     commands. Default tests use the private scripted transport, not Docker.
  6. Review against the spec and changed-file scope; record evidence and hand
     off to `SBX-013`. Do not mark local runtime compatibility or release proven.
- Acceptance matrix:
  - `ACC-SBX-DOCKER`: public factory/contract/type tests prove ordinary Harness
    composition, local scope isolation, lifecycle, execution, conflict/stale
    denial, security defaults, and no dependency inversion.
  - `ACC-SBX-DOCKER-LOSS`: failure/privacy tests prove missing metadata,
    container, or volume never creates empty state; unavailable engine stays
    operational failure; restore fails before mutation; retries complete only
    owned cleanup; diagnostics contain no private refs/paths/commands/content.
- Autonomy: D0/D1 under `POL-SBX-MECHANICAL` only. Missing semantics return to
  spec review; do not design another workspace adapter, shared service, or
  public ownership API.

### SBX-013 — prove Docker/OrbStack behavior and publish local setup guidance

- Status: complete for available OrbStack target: 20 live tests, standalone
  example, docs, package dry-run and license checks pass. Other engines and
  registry publication are not claimed; provider gates remain unchanged.
- Repository: `ai-harness`.
- Read scope: `SBX-012` implementation/evidence and the same Docker spec,
  traceability, and public-contract refs.
- Write scope: Docker package live tests/scripts/README, private
  `examples/local-docker-sandbox/**`, and focused public docs/implemented-skill
  projection. No production provider adapter or framework source changes.
- Deliverable: a standalone example and opt-in local engine evidence, with
  documented setup, ownership, resource/security limits, persistence matrix,
  cleanup retry, state loss, rollback, and supported-version matrix.
- Action plan / test-first order:
  1. Review `SBX-012` evidence; add opt-in `test:docker` tests before describing
     support. Require caller-provisioned image/engine and explicit
     `PURISTA_DOCKER_SANDBOX_TEST=1`; missing opt-in skips, explicit opt-in with missing
     prerequisites fails with safe diagnostics.
  2. Exercise public standalone Harness calls through real container FS,
     exec/spawn, release, process restart/reattach, missing container/volume,
     ownership conflict, cancellation, and cleanup retry. Check actual guest
     processes stop; a terminated host CLI is insufficient evidence.
  3. Run `npm run test:docker --workspace @purista/harness-sandbox-docker`
     separately on available Linux Docker Engine, macOS Docker Desktop, and
     macOS OrbStack. Record exact versions/image/platform and pass/fail/not-run.
     Unavailable environments remain unsupported/unverified; no fabricated
     compatibility claim. Clean only exact disposable resources created by tests.
  4. Add the standalone example and README from passing behavior. Explain that
     no cloud credentials or PURISTA are required, volumes are not checkpoints,
     restore is initially unsupported, and Docker access is host authority.
  5. Run package checks, example build/tests, and required docs/skills audits;
     review dependency/license/vulnerability/provenance evidence before release.
  6. Record evidence against `ACC-SBX-DOCKER` and `ACC-SBX-DOCKER-LOSS` and request
     review of the local release gate. Keep E2B/Daytona gates unchanged.
- Default commands remain hermetic. Live tests are explicit, authorized
  local-engine mutations, never unconditional root CI.

## Wave 4 — production reference, provider-gated

### SBX-010 — implement exactly one approved provider addon

- Status: blocked on `SBX-004`, `SBX-005`, `SBX-009`, and `GATE-SBX-PROVIDER`.
- Repository: `ai-harness` optional package only.
- Write scope: one `packages/harness-sandbox-<approved-provider>` package and
  its tests; core changes are prohibited unless separately approved as contract
  corrections.
- Deliverable: thin mapping over the approved SDK/control plane, with adapter
  configuration owning lifecycle policy and optional compatible workspace
  factory when the decision requires it.
- Acceptance: all shared contracts, failure/cancellation mapping, stale
  mutation denial, cleanup/orphan behavior, dependency checks, privacy tests,
  and credential-gated smoke tests pass.

### SBX-011 — release documentation and real two-replica example

- Status: blocked on `SBX-010`.
- Repositories: `ai-harness`, public handbook/docs, then PURISTA/voyage
  projection only where the approved adapter is exposed.
- Deliverable: provider setup, two-replica example, recovery/retention/runbook,
  troubleshooting, and an explicit preservation matrix for files, packages,
  environment, and live processes.
- Acceptance: verified commands/links, no credentials, no ambiguous
  “persistent” claim, each adapter's lifecycle authority stays explicit, and
  all repository documentation/skill/knowledge audits pass.

## Verification envelope

Each implementation ticket runs focused tests first, then the repository's
applicable `lint`, `typecheck`, type-test, unit, contract, integration, failure,
build, export, dependency, and telemetry privacy checks. Provider tickets add
opt-in live checks only when credentials are present. PURISTA tickets run the
workspace-prescribed skill and knowledge audits.

## Self-audit and deferred scope

- Docker adds one package and two bounded tickets; no core subsystem, topology
  signal, optional-package auto-detection, or provider-selection dependency.
- The existing-adapter rewrite is explicit source work, not deferred to docs:
  `SBX-001` owns in-memory/Bash; `SBX-002` owns shared fakes/suites; `SBX-003`
  owns runtime/test callers; `SBX-014` owns both local-directory variants and
  local bundle binding; `SBX-004` owns final consumer/guidance alignment and
  the joint clean-break gate. PURISTA waits for that standalone gate.
- Real local smoke tests and shared host ownership tests do not substitute for
  distributed provider conformance or a hostile multi-tenant security review.
- Checkpoint-backed Docker recovery, immutable plugin mounts, remote engines,
  hard disk quotas, and live-process snapshots are explicitly not in the first
  slice. They require an approved extension before implementation.
- This repository's existing compact plan is retained; a mechanical migration
  to the planner skill's full ticket/index format is not part of this addition.
  Do not treat a structural-check exception as evidence of runtime correctness.
  The 2026-08-26 checker run reports missing modern indexes/entrypoint,
  incompatible flow mappings, and stale repository-wide plan hashes. The new
  unexecuted provider tickets remain deferred or blocked; machine-executable
  promotion requires format reconciliation and their listed dependencies.
  This compact record tracks directly authorized implementation evidence, not
  a claim that the generic AFK ticket-format gate passed. Unrelated plans and
  their manifest were not rewritten.
