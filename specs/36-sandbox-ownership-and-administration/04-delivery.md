# Clean-break delivery and precedence

## Precedence

Spec 36 replaces the following earlier rules **only** within this follow-up:

| Earlier source | Replaced rule | Canonical replacement |
| --- | --- | --- |
| 05, 13, 34 scope/open contracts | Session fields directly in scope; core tracks first partition creation | `SandboxOwner`, partition, owner registration and lazy create in CTR-SOWN-OWNER/OPEN |
| 09, 10, 25, 28 | No per-definition sharing; children always isolated | Policy precedence and typed literal groups in REQ-SOWN-POLICY |
| 11, 32, 34 | Bare identity getSession argument; eager sandbox allocation; close only session compute | SessionOptions, immutable binding, lazy allocation and dispose/close |
| 21, 22, 34 | One guest root; unchecked TTL/quota fields; no aggregate pins | Run partition tree, owner metadata, checkpoint pins and enforced supported policy |
| 14, 15, 16 | Previous error/export/test inventory | Additions in CTR-SOWN-ERRORS and 04-verification |
| 34 out-of-scope administration | No public lifecycle administration | Adapter-only operator property; still no core daemon/control plane |
| PURISTA AgentSandboxPolicy | enabled/per-agent adapter switch and release-only ephemeral behavior | Service-owned adapter binding, definition sharing/owner policy and replay-safe disposal |

All other active rules remain in force, particularly spec-34 missing-state
protection, topology transparency, Docker security/packaging, and provider gate.
The dated completion audit and accepted tickets describe their earlier state;
do not rewrite them to claim this follow-up was already implemented.

## DEC-SOWN-DELIVERY

This is a clean source/API refactor, not a compatibility project. All consumers
change together; do not publish partially updated packages. No compatibility
adapter, dual old/new signature, migration flag, legacy type alias, or silent
fallback is allowed. Foundation types may be developed before the atomic port
cutover but are not a second runtime contract and are not separately released.
The approved horizontal foundation stages are closed schemas/errors, private
local catalog, and private Docker catalog. The following atomic base-port cutover
updates implementations and callers in one phase-gated ticket. Sharing, durable
aggregate recovery, retention, replay and framework configuration then form
separate tested increments. No intermediate state is a releasable spec-36 package.
Workspace staging is exact: base-port cutover adds real owner metadata and real
indexed administration, conservatively protecting every copied checkpoint whose
publication status is not yet reconciled. It does not add placeholder pin,
releaseCheckpoint or finish methods. The durable-partition ticket atomically adds
those required methods with their implementations/call sites and committed
membership fields. The retention ticket then enables the declared TTL/GC matrix.
Before that ticket, unsupported TTL/quota inputs are rejected, never ignored;
sweep may delete only proven eligible non-recovery resources. No no-op required
method is used to make a partial phase compile.

An offline packed-PURISTA verification foundation also precedes the cutover;
VERIFY-SOWN-PACKAGED-PURISTA freezes its commands, scratch/cache boundaries and
existing external-declaration release prerequisites. This is test infrastructure,
not a new runtime package or permission to remediate unrelated dependencies.

Existing user files are not disposable test fixtures. Bump the private persisted
layout/schema version when needed. On opening an older layout, fail a specific
configuration/state error before mutating it and explain that it is unsupported
by this clean release. This plan adds no automatic data migration and must not
erase, rename, or adopt old directories as new empty resources. Fresh examples
use new explicit roots; fixture-only cleanup uses exact test-created paths.

## File ownership and modularity

Harness public DTO schemas belong in `packages/harness/src/sandbox/ownership.ts`
and `administration.ts`, re-exported by existing `sandbox/index.ts` and root
`index.ts`. Definition policy resolver belongs in `sessions/sandboxBindings.ts`;
do not append another monolithic subsystem to `sessions/index.ts`. Keep adapter-
private lifecycle/index logic near existing `sandbox/lifecycle.ts`,
`local/local-sandbox-state.ts`, and `local/local-workspace.ts`; extract focused
private modules for catalog/retention rather than copy business rules into each
factory. Docker owns its private records/engine implementation in its own package
and imports only public Harness/testing exports. It must not import core's private
catalog helper. Shared conformance tests, not a new provider-neutral database,
keep independently implemented catalogs aligned.

Persisted session bindings stay in `models/state.ts` and the existing storage
implementations. Workspace additions stay in `ports/workspace.ts` and
`runtime/sessionDurable.ts`, with a private focused checkpoint coordinator for
aggregate barriers and pin ordering. No generic resource graph, event bus, distributed scheduler, or extra
package is introduced. PURISTA changes stay inside AgentQueueBuilder integration,
Service AI configuration, public exports, tests, and directly affected guidance.

## Autonomous execution constraints

Every ticket pins this spec's digest and the nested plan digest. Only D0 mechanical
changes and D1 private reversible helpers/test placement are discretionary.
Public names, defaults, errors, ownership, cleanup authority, unsupported cases,
security and package boundaries are already decided here. Missing prerequisites
or inconsistent contracts are blockers returned to spec review, not invitations
to invent. Scope changes require a revised approved digest and regenerated plan.

Start from the dirty-worktree baseline and preserve unrelated evaluation and
handbook work. Never reset, bulk-format, or stage the workspace. Build-generated
outputs are not handwritten. Agent completion is `implemented`, independent
review promotes to `accepted`; an implementation agent cannot self-approve.

Documentation, examples, public TSDoc and the canonical Harness/PURISTA skills
are updated in the delivery ticket after behavior exists. Installed skill mirrors
are not the source of truth. Run PURISTA knowledge/skill audits whenever specs or
guidance change. No implementation, provider bake-off, image pull, release,
publication, or external deletion is authorized by this planning turn.
