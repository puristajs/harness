# Acceptance, safety, and operational evidence

All cases use public entrypoints and real local components where applicable.
Passing type checks or fake-only tests is not evidence for Docker process fencing
or durable restart recovery. Production-provider tests remain separately gated.

## ACC-SOWN-POLICY — definition and child selection

One session executes two agents and two workflows: default sharing sees the same
file; private agent/workflow keys are disjoint and stable across turns; group
members share only within the owner/lifetime; inline inheritance follows a private
parent. Different Harnesses sharing an explicit owner still have distinct private
definitions. Child tasks are isolated by default, including continuables; explicit
inherit/group shares files but never history. Shared child completion/cancellation
does not terminate parent compute. Child override beats definition policy.
Tests: `test/sandbox-sharing.test.ts`, `test/workflow-child-tasks.test.ts`,
`type-tests/harness-typing.ts`. Unknown groups/legacy options fail compile and JS
build validation; module composition retains literal groups and capabilities.

## ACC-SOWN-OWNER — identity, authorization, and lazy first use

Exact optional tenant/principal tuples cannot collide; principal-scoped owners
deny a different principal, tenant owners require explicit authorization, omitted
tenant never means wildcard. Same owner shares files across independent sessions
without messages/memory. Test fresh get/release/restart/first invocation, two
concurrent session creators, crash before/after registration acknowledgement,
partition provisioning timeout and reconciliation, known missing owner/compute,
terminated partition, changed owner/digest, and authorization callback failure.
No denial calls the model/provider. Tests: `test/sandbox-ownership.test.ts`,
`src/storage/storage-contract.test.ts`, base sandbox contract and two-client suite.

## ACC-SOWN-DURABLE — aggregate checkpoint and recovery

Private/group writes in one run survive a process restart from one committed
checkpoint. Primary cannot read sibling paths via traversal/symlink. Crash during
copy/publication/restore retains the prior recovery point; all old partition
attachments are fenced before replacement. Changed digest, external owner,
unjoined child, active spawn writer, concurrent commit, and missing committed
checkpoint fail before unsafe mutation. Pin publication crash keeps both points
until reconciliation, and default isolated tasks cannot masquerade as committed
parent state. Tests: `test/sandbox-durable-partitions.test.ts`,
`test/local-durable-execution.test.ts`, `test/local-sandbox-workspace-isolation.test.ts`.

## ACC-SOWN-ADMIN — precise offboarding and retry

Inventory finds retained session/run resources and snapshots after storage rows
are removed. Principal purge deletes only principal-owned data, revokes that
principal's live tenant-shared attachments, and leaves another principal working.
Tenant purge includes principal-owned descendants. Same principal in another
tenant/namespace is untouched. Test absent-target purge/create race, two clients,
queued writes, open/spawn/restore/snapshot races, uncertain provider creation,
partial delete, cancellation after barrier, restart, selector/key conflict,
cursor mismatch, and full catalog reserve. No partial result claims completion.
Tests: `test/sandbox-administration.test.ts`, shared administrative contract,
Docker fake engine tests, and local workspace contract fixtures.

## ACC-SOWN-BOUNDS — retention and capacities

Use a controlled clock and very small limits to prove count/byte reservations,
bounded pagination, TTL eligibility, pinned protection, aggregate temporary-copy
accounting, failed-delete capacity, orphan reconciliation, and admission denial
without loss. Unknown/supplied unsupported fields fail construction. Docker's
unsupported hard live-volume quota fails before engine access. Tombstone/catalog
capacity never causes resurrection; reserved offboarding still works at normal
capacity. Tests: `test/sandbox-retention.test.ts`,
`test/local-workspace-retention.test.ts`, Docker options/administration tests.

## ACC-SOWN-PURISTA — framework mapping and ephemeral replay

Different trusted identities with equal conversation/durable keys receive distinct
hashed IDs. Separate attached agents share only an explicit authorized owner;
local delegates obey policies and `canInvokeAgent` doesn't transfer handles.
`enabled: false` and a per-agent adapter override fail validation; an in-memory
files-only adapter stays explicit at service composition.
Prompt and stream duplicates return persisted terminal outputs after compute
purge with zero model/sandbox opens. Suspended/retryable runs retain files; a
cleanup failure cannot replace terminal success/error. Borrowed owner completion
does not delete shared files. No-Harness custom handlers allocate no sandbox.
Tests: PURISTA `AgentQueueBuilder/runtime/identity.test.ts`, `executor.test.ts`,
`scopedRuntime.test.ts`, and `agentQueueBuilder.test.ts` plus a public smoke fixture.

## ACC-SOWN-SAFETY — errors, telemetry, and dependency boundaries

Contract fixtures assert exact error class/code/category/retriable flags and
closed metadata. Sentinel owner/tenant/principal/path/provider/snapshot/cursor/
command/content values never enter standard logs, spans, metrics or serialized
public errors, including nested causes and partial cleanup. Administrative list
results intentionally carry identity only to the trusted caller. No metric label
is an owner/group/session/resource ID. Existing NO_CONTENT behavior stays default.

Retain existing `harness.sandbox.<operation>` span names and the
`harness.sandbox.operation` attribute, with the existing adapter ID and operation
enum `register_owner|open|detach|terminate|list|purge|sweep|delete_snapshot`,
outcome enum `success|denied|conflict|state_lost|quota|cleanup_pending|cancelled|error`,
and numeric duration/count fields. Reuse the existing sandbox telemetry helper
and semantic conventions; no independent metrics pipeline or raw-error logging.
Workspace operations use the existing workspace spans with the same redaction.
Tests: `test/sandbox-telemetry.test.ts`, `test/telemetry-flow.test.ts`, public type
and package-boundary tests.

## ACC-SOWN-DELIVERY — one clean release

Every existing sandbox factory, localDurableExecution binding, snapshot fake,
inline test double, Docker addon, Harness caller, PURISTA caller and active guide
uses the new contract. No legacy wrapper, migration overload, permissive schema,
`MultiInstanceSandbox`, public lease/fence/provider ID, or runtime topology branch
remains. Existing data paths are not erased by the refactor; old persisted layouts
are rejected explicitly, never adopted as empty. See delivery's data rule.

Compile and test Harness, Docker and scoped PURISTA; run full Harness regression,
type inference, coverage and architecture gates. Pack/build Harness and Docker
with the existing package check and verify runtime/declarations in an isolated
consumer without PURISTA Core installed. Build framework integration against
public Harness exports. Live local Docker tests require an explicitly supplied
engine and preloaded image and must report engine/platform evidence; no image
pull or cloud-provider credentials are implicit. Failure is blocked, not waived.

## Nonfunctional bounds and verification commands

List/sweep never return more than the requested 1..1000 records; default 100.
No unbounded Promise.all for deletion or checkpoint copies. Local catalog writes
and allocation are serialized/transactional under their existing authority;
concurrent clients must observe committed revocation before mutation admission.
Use AbortSignal and existing timeout handling; no new infinite retry loop.
All new runtime branches have unit/failure tests; preserve existing coverage
thresholds rather than lowering them. CPU/RAM/disk-load benchmarks are not a
substitute for the deterministic capacity assertions above.

From `ai-harness`: `npm run test --workspace @purista/harness`,
`npm run test:types`, `npm run typecheck`, `npm run test:coverage --workspace
@purista/harness`, `npm run test --workspace @purista/harness-sandbox-docker`,
`npm run verify:architecture`, `npm run verify:sandbox-packages`.
From `purista`: scoped Vitest/TypeScript checks from ticket command records,
`npm run audit:skills`, `npm run audit:knowledge`, and the public package smoke.
No project dependency install/update, network fetch, provider write or publication
is a default autonomous verification action. The isolated offline test-install
exception below does not modify either repository's dependency tree or lockfile.

## VERIFY-SOWN-PACKAGED-PURISTA — prerequisite and limits

The current PURISTA node_modules resolves Harness 1.7.3 despite its manifest
declaring ^3.0.0. Running the existing framework typecheck against that install
does not prove this contract. A test-infrastructure foundation must precede the
atomic cutover: `ai-harness/scripts/check-purista-sandbox.mjs` with modes
`--mode source`, `--mode consumer`, and `--mode docs`, plus hermetic runner tests.

The runner builds/packs the local Harness, stages a copy of Core sources and
required repository configs in a uniquely created workspace-local scratch root,
installs the actual Harness tarball there, and runs Core source compilation and
the scoped AgentQueueBuilder tests against its public declarations/runtime.
Core's existing self-reference within its own source build is retained; no alias,
shim or symlink may resolve Harness to source. Consumer mode builds/packs staged
Core and tests actual Core+Harness tarballs with strict external declarations and
public runtime calls; no source aliases or skipLibCheck in that consumer. Docs
mode uses the same packaged Harness binding for Core/API/website builds and the
existing internal-link audit, preserving copied repository build conventions.

All temporary roots and npm cache/output paths are under
`ai-harness/.sandbox-verification/`, with unique per-run children. Read inputs
from existing local package artifacts and an explicitly prepopulated offline
cache; a missing cached dependency fails before attempting network. Test installs
use `--offline --ignore-scripts --no-audit --no-fund` and an explicit workspace
cache. Build scripts are invoked separately from the known local source snapshot.
Remove only the exact scratch directory created by that invocation; retain
failure evidence in the plan evidence directory. Never overwrite the developer's
PURISTA node_modules, fake lockfile integrity, or fetch unpublished Harness 3.
Bring the existing Harness/Docker package checker under the same scratch/cache
rules before using it as a default workspace-only command.

Source mode preserves the existing Core tsconfig settings; it does not lower
them. Consumer mode must separately report current pre-existing strict external
declaration failures: dev-only @types/sinon referenced by Core declarations and
thread-stream's TransferListItem reference absent from the installed Node 26
types. Those are explicit release prerequisites outside this sandbox refactor,
not waived checks or permission to patch third-party dependencies/ambient types.
Source behavior tickets may complete with valid source-mode proof; final release
acceptance remains blocked until consumer mode passes under separately approved
dependency/package remediation. No implementer chooses a dependency workaround.
