# Sandbox completion audit

Status: scoped implementation, tightening, and behavioral verification complete;
coverage, architecture, and standalone packed-package gates pass. Release and
external declaration limits remain explicit below. This record supersedes the previous completion
claim; green compilation and old test selections were insufficient evidence.
Scope is the implemented local/Harness/PURISTA sandbox increment, not cloud
provider selection, npm publication, or a distributed production certification.

## Findings and resolution

| Area | Evidence gap found on 2026-08-26 | Required proof |
| --- | --- | --- |
| Built-in lifecycle | Duplicate create threw; termination deleted lookup state but retained usable handles and allowed recreation | Idempotent create, stale read/write/exec denial, terminal tombstones, cancellation |
| Logical identity | Local path derivation omitted harness name, session incarnation, identity, and role | Full-scope separation, exact optional identity, immutable persisted instanceId, conditional session writes/deletion |
| Local persistence | Existing directories were treated as lifecycle authority; no private records or tombstones | Restart attach using validated private metadata; missing metadata/data fails closed; cleanup retries |
| Type inference | Scope lifetime/run ID not statically coupled; spawn capability absent from result projection | Negative scope types, precise filesystem/exec/spawn result types and builder inference |
| Runtime integration | Session/durable/child-task order and lifecycle telemetry need direct coverage | Two independent clients, checkpoint binding before restore, termination before storage deletion, privacy |
| Docker | Only configuration tests; ownership, transport failures and guest cancellation unproven | Private transport tests plus opt-in real engine proof and exact-resource cleanup |
| Documentation/release | Package setup was described before engine evidence | Tested example, bounded compatibility matrix, regenerated API evidence and rendered docs |

Unrelated evaluation plans and handbook restructuring remain outside this repair.
No E2B/Daytona production adapter is implemented. Unavailable engine evidence
must remain explicitly unverified rather than being inferred from CLI support.

## Tightening decisions

- Keep one public Sandbox contract; no MultiInstanceSandbox, public lease/fence,
  lifecycle facade, topology flag, core cleanup daemon, or compatibility branch.
- Session incarnation is an opaque persisted ULID, not a timestamp. Insert-only
  creation, update-only summary writes, and conditional deletion prevent stale
  facades or delayed work from resurrecting/deleting a replacement conversation.
  These are session integrity rules, not sandbox lifecycle storage.
- Local lifecycle records and tombstones remain private. Workspace owner claims
  bind the complete scope outside guest files/checkpoints. Restore retries use
  the existing private workspace resume key; no new public binding port.
- Existing runs without a committed workspace checkpoint fail state loss.
  Successful business outcomes remain terminal if cleanup fails; warnings are
  content-free and cleanup retry stays adapter/operator-owned.
- Process admission rechecks attachment authority after asynchronous path work.
  Close/terminate can stop active children promptly, handle SIGTERM-resistant
  children, and retry cleanup without admitting new work.
- Invalid lifecycle modes/reasons fail before mutation; filesystem errors are
  sanitized, and cancellation is rechecked immediately before process allocation.
  Seventy new failure-path tests cover these fixes and existing lifecycle branches.
- Capability tuples infer filesystem/exec/spawn handles through builder chains;
  widened or union types never invent executor availability. Optional snapshot
  APIs stay separate from durable lifecycle restore, but now reuse full target
  scope and base sessions rather than retaining an incomplete session/run pair.
  The snapshot fake participates in the same target lifecycle and shared suite.
- Docker is one optional, public-Harness-only package. Retained volumes are not
  durable checkpoints. No cloud SDK, auto-pull, raw Docker flags, host mounts,
  remote daemon support, or host execution fallback.

## Verification evidence — 2026-08-26

| Surface | Evidence |
| --- | --- |
| Harness | 699 tests across 57 files pass under coverage and normal runs; source/type checks, 126 shared storage/sandbox contract tests, 3 failure tests, 57 integration tests and full workspace lint/typecheck/build/test commands pass. Coverage: 86.84% statements, 80.21% branches, 88.57% functions, 90% lines; thresholds unchanged. Opt-in infrastructure suites stay skipped unless explicitly enabled |
| Local execution | Real process tests for close/start races, bounded termination, cleanup retry, metadata/data loss, full-scope workspace isolation, committed recovery, and content-free telemetry |
| Docker hermetic | 41 private scripted-transport/base-contract tests pass, including configuration/type, failure/cancellation/privacy; normal test command skips explicit live suite |
| Docker real engine | 20 live checks and standalone example passed on macOS 26.5.2 arm64, OrbStack 2.2.3 (2020300), Docker CLI/Engine 29.4.0; immutable fixture sha256:41b693b5051e085a60b9a75c51226df6699d84660ae5b2cefef09bf97fc5ab50 |
| Examples | All 13 Harness example builds and 40 tests across 11 suites passed; standalone Docker example uses no model or Framework |
| PURISTA | 40 scoped-runtime/agent-builder tests and 5 agent-example tests pass, including 5 new public test-helper regressions; full framework unit typecheck and strict example typecheck pass against built local Harness 3. Isolated packed Core + Harness runtime proves identity, create→attach and release; consumer code typechecks with skipLibCheck, but full external declaration checking has pre-existing failures listed below |
| Package | `npm run verify:sandbox-packages` passes: actual packed Harness + Docker tarballs installed offline in an isolated consumer, runtime and strict declaration checks with skipLibCheck false, capability inference and private-subpath rejection, no Framework/source alias/symlink. Docker has matching Apache-2.0 LICENSE and no credentials/live fixtures in shipped package |
| Architecture | 13 dependency-boundary tests and 2 capability-family checks pass; runtime, peer, dev and optional dependencies reject Harness/addon→Framework edges. Only 3 explicitly approved detector→provider-neutral guardrails-contract edges are allowed; no unrelated guardrails source/package changes |
| API documentation | Fresh Framework TypeDoc via website build; standalone Harness TypeDoc JSON: zero errors, 35 warnings; Docker API JSON: zero warnings. Private structural types inline without public helper exports |
| Website | Build: 1086 pages; link audit: 1283 HTML pages, all links resolve, 2 existing approved fragment redirects. Both affected pages checked at 1440px and 390px with no horizontal overflow or browser errors |
| Skills/specs | PURISTA skill and knowledge audits pass; installed Harness skill byte-for-byte sync passes; spec-34 manifest regenerated and deterministic checker passes |

The new failure-sentinel tests inspect native/Harness errors, warning metadata,
span error objects and metrics, including actual bound tenant/principal values.
Local sandbox metrics omit workspace hashes as well as raw references.
The final real-engine and example runs left no labeled containers or volumes.
The disposable fixture image was removed; its recorded source/Dockerfile can
rebuild it, and the pre-existing base image was retained.

## Documentation coverage

| Reader outcome | Canonical owner | Implementation/test evidence |
| --- | --- | --- |
| Choose a sandbox and understand lifecycle | PURISTA website Harness secure-and-govern/sandbox-and-mcp; Harness configuration/security guides | Sandbox public types, shared contract, session lifecycle tests |
| Run Docker/OrbStack without Framework or a model | Harness secure-and-govern/local-docker-sandbox; Docker README; examples/local-docker-sandbox | Strict snippet compilation, hermetic/live tests, standalone smoke |
| Recover durable files without empty replacement | Harness durable-workspaces guide and operations runbook | Durable-session and local-durable-execution tests |
| Integrate with Framework | Existing Framework agent runtime guidance and canonical PURISTA skill | scopedRuntime tests, actual example runtime adapter |
| Author adapters with inferred types | Harness skill sandbox/adapters references and source TSDoc | Type tests, public exports, generated TypeDoc evidence |

The docs-maintainer workflow kept Docker setup under the existing Harness
sandbox topic, separate from Framework navigation and runtime ownership; no
competing general sandbox page or provider setup promise was introduced.

## Explicit release limits

- Docker Desktop, native Linux Docker, and Bun runtime behavior are not verified
  by this macOS/Node run. Local directory execution remains trusted one-process
  ownership per root; Docker remains trusted one-local-engine execution, not a
  hostile multi-tenant or distributed production sandbox.
- E2B/Daytona probes, control-plane selection, cloud adapters, two-replica live
  examples, checkpoint-backed Docker recovery, and immutable plugin mounts stay
  deferred/provider-gated. No new compatibility layer was added to fill them.
- No packages were published. PURISTA's existing dependency resolutions include
  older Harness versions; cached registry metadata has no Harness 3 release
  (`ETARGET` offline). The example declares its direct ^3 dependency. Actual
  tarball installation/runtime and standalone declarations are proven, not a
  fresh registry release; no fake lock integrity/resolution was added.
- Strict external declaration checking of the packed PURISTA consumer reports
  existing Core declarations referencing dev-only `@types/sinon`, and
  `thread-stream` referencing `worker_threads.TransferListItem` absent from Node
  26 types. Consumer-code checking with `skipLibCheck` and real runtime both
  pass. No ambient shim, dependency patch, or unrelated Framework dependency
  refactor was added to conceal these release concerns. The standalone Harness
  and Docker consumer passes with `skipLibCheck: false`.
- TypeDoc retains existing unresolved-reference warnings plus one private
  recursive-capability helper warning; no public type redesign was introduced
  solely to silence the renderer. Site builds retain unrelated chunk-size and
  legacy markdown-route warnings.
- The generic planner checker cannot consume the repository's existing compact
  dated ticket/index layout. This record does not claim that AFK format gate
  passed; deferred tickets require format reconciliation before promotion.
