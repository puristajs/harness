# Evaluation workstream: revision and delivery plan

Status: planning-only; product direction auto-approved by the owner. Contract
revision is the next task. Implementation tickets below are dependency-bound
delivery tickets, not dispatch-ready AFK tickets until REV-001 is complete.

Date: 2026-08-26. Planned at Harness `c378607de9e7f19e3e985b8f8dbd84457ae5592a`.
Priority: P1. Category: direction, contracts, documentation. Overall effort: L.
Contract/runtime risk: medium; public teaching and example risk: medium.

## Outcome and authority

Ship a small provider-neutral execute/score toolkit and a comprehensive
method-first handbook. Scorers are interchangeable typed adapters, including
deterministic and injected model-backed implementations. Users can re-score
existing observations without rerunning their system. OpenTelemetry is optional
at runtime; model identity, normalized token usage and cost attribution reuse
the existing Harness architecture, with task and judge accounting separated.

The detailed decisions and source research are in
[methods and toolkit direction](./2026-08-26-evaluation-methods-and-toolkit-direction.md).
Both documents are planning artifacts, not competing canonical API contracts.
Spec 35 and its related public-API/telemetry/testing documents must be reconciled
before implementation. Standing auto-approval removes a product-approval wait;
it does not turn known contract gaps into a passed readiness review.

This plan supersedes the execution ordering/status of the
[August 25 ticket plan](./2026-08-25-generic-evaluation-run-result-implementation-plan.md).
Its useful test cases can be carried forward after reconciliation. Do not
implement its EVAL-101 under the old ready status or retain its deferred-only
cookbook, partial schema validator, or combined task/judge accounting.

Current task writes are limited to `ai-harness/plans/`. Future ticket write
scopes below are not permission to implement during this planning task.
Preserve all unrelated sandbox, storage and shared-spec changes. No commits,
pushes, deployments, published issues, installs or live model runs are implied.

## Verified current state and drift check

Workspace root: `/Users/sebastianwessel/projekte/@purista`.

- `ai-harness/packages/harness/src/eval/index.ts` still contains
  `evaluatePromptCandidates` and the standalone deterministic evaluator.
- `ai-harness/specs/35-generic-evaluation-runs.md` proposes the replacement but
  always runs a task before scoring, requires original task timing, and has no
  dimension-level inconclusive/not-applicable result. It adds successful task
  and judge usage into candidate totals and treats missing usage as zero.
- Its `EvaluationTaskTarget` includes `expected`; revise this so hidden grading
  references are not passed automatically to candidate execution.
- `models/registry.ts` already emits model alias/provider/model identity and
  normalized usage. `TokenUsage` includes cache/reasoning details. The existing
  nested-model pattern, also specified for guardrails, owns cost attribution.
- `sessions/index.ts#getRunSummary` reads stored events without OTel, but returns
  flat totals and counts rather than per-model accounting completeness.
- `telemetry/shim.ts` uses the OTel API; SDK/exporter setup is application-owned.
- `ports/feedback.ts#FeedbackRecord` is an optional signal attached to a Harness
  target, not an experiment result or complete observation.
- The canonical public evaluation section currently has three pages in
  `purista/web/src/content/handbook/harness/test-and-evaluate/`; the prompt page
  still uses the old helper. No seven-recipe cookbook exists there yet.

Before a dispatched ticket, run in `ai-harness`:

```sh
git status --short
git diff --stat c378607..HEAD -- packages/harness/src/eval packages/harness/src/models packages/harness/src/sessions specs plans
```

Also inspect uncommitted diffs in the ticket's exact paths; the commit diff does
not show those. If relevant contracts/source changed, reconcile the ticket
before edits. No branch creation or git cleanup is required by this plan.

## Execution index

This scoped index follows the repository's dated plan convention rather than
replacing an unrelated repository-wide plans index.

| Ticket | Outcome | Depends on | Status | Effort |
| --- | --- | --- | --- | --- |
| REV-001 | Reconcile canonical contracts and readiness | none | TODO — specs only | M |
| REV-002 | Freeze handbook coverage, routes and example contracts | REV-001 | BLOCKED — contracts | M |
| REV-101 | Clean-break execute/score vertical slice | REV-001 | BLOCKED — contracts | L |
| REV-102 | Reuse model accounting and optional OTel correctly | REV-101 | BLOCKED — runtime | M |
| REV-103 | Deterministic and calibrated judge reference adapters | REV-002, REV-102 | BLOCKED — example contract/runtime | M |
| REV-104 | Analysis, coverage and paired-comparison examples | REV-103 | BLOCKED — results | M |
| REV-201 | Beginner path and classification recipe | REV-002, REV-104 | BLOCKED — maintained example | M |
| REV-202 | Extraction recipe | REV-201 | BLOCKED — shared recipe shell | M |
| REV-203 | RAG recipe | REV-201 | BLOCKED — shared recipe shell | M |
| REV-204 | Translation recipe | REV-201 | BLOCKED — shared recipe shell | M |
| REV-205 | Agent-loop/tool-call recipe | REV-201 | BLOCKED — shared recipe shell | M |
| REV-206 | Subagent-as-tool recipe | REV-205 | BLOCKED — agent fixture | M |
| REV-207 | Workflow recipe | REV-205 | BLOCKED — agent fixture | M |
| REV-208 | Dataset, calibration, comparison and operations handbook | REV-201 | BLOCKED — beginner vocabulary | M |
| REV-301 | Platform-neutral mapping fixture and Langfuse example | REV-102, REV-201, REV-208 | BLOCKED — generic substrate | M |
| REV-302 | Phoenix example | REV-301 mapping fixture only | OPTIONAL — independent vendor slice | M |
| REV-303 | Datadog example | REV-301 mapping fixture only | OPTIONAL — independent vendor slice | M |
| REV-401 | Summarization/rewriting recipe | REV-208 | FOLLOW-UP — useful next recipe | M |
| REV-402 | Multi-turn support/memory recipe | REV-208, REV-205 | FOLLOW-UP | M |
| REV-500 | Cross-repository readiness/release review | all committed core/handbook tickets | BLOCKED — delivery | M |

REV-302 and REV-303 do not depend on each other or a live Langfuse account.
REV-301's vendor-neutral mapping fixture can be reviewed separately. Optional
vendors do not block core/cookbook delivery. Shared navigation/spec files have
one writer; recipe authors can work independently after REV-002 freezes routes.

## REV-001 — Reconcile canonical contracts and readiness

This is the next concrete planning/specification ticket; it does not implement
code. Read workspace AGENTS, canonical PURISTA skill, Harness guidance and the
applicable spec authoring/readiness/planning skills before editing.

Write scope:

- `ai-harness/specs/35-generic-evaluation-runs.md`;
- evaluation/model-accounting sections only in specs `06-models.md`,
  `13-public-api.md`, `14-otel-conventions.md`, `15-error-catalog.md`,
  `16-testing.md`, `17-implementation-plan.md`, `19-ai-eval-core.md`;
- evaluation entries only in `specs/README.md`, `specs/.readiness-report.yaml`
  and these evaluation planning documents.

Steps and required contract decisions:

1. Replace the task-dependent scorer target with a generic observation contract.
   Freeze execute-and-score and score-only signatures using the same scorer
   interface and engine. Define original observation identity and provenance,
   protected inputs, absent original metrics, and new scoring-run identity.
2. Keep references out of candidate task targets. Separate safe task context
   from scorer-only context. Define immutable per-scorer data projection and
   reject malformed observation identities before starting callbacks.
3. Freeze scored/not-applicable/inconclusive dimensions, operational states,
   explicit reasons, counts and denominators. Retain value kind/units/direction,
   bounded evidence, safe errors, segments and stable ordering. Fix the current
   prose/type mismatch where `EvaluationCaseResult.segments` is mentioned but
   absent from the interface.
4. Define a bounded trial count defaulting to one; unique candidate/case/trial
   rows; attempts only for technical retries; fixture/reset ownership; global
   work/cardinality caps and concurrency across trials. Keep deadline,
   cancellation, fail-fast, late-completion and cleanup behavior explicit.
5. Replace reduced `EvaluationUsage` with reuse of normalized `TokenUsage` and
   explicit task/scorer accounting. Specify optional model identity groups,
   operation/call identity and duplicate ownership; distinguish absent data,
   partial data and a genuine reported zero. Decide the smallest shared
   runtime-summary extension needed for collector-free accounting; do not
   duplicate the registry's instrumentation. Cover embeddings, reranking,
   delegation, retries, failed calls and streamed final-usage reports.
6. Define cost source/currency/pricing provenance, task duration versus scorer
   duration versus wall time, and re-score provenance versus new spend.
   Freeze the optional OTel hierarchy, existing flavor/content behavior and
   no-double-counting rules. Model attributes belong on normal model spans.
7. Replace the proposed limited JSON-schema factory with a predicate adapter
   plus an injected-validator example. Freeze any public helper only after
   tracing deterministic and structured-model-judge examples on paper.
8. Keep `FeedbackRecord` separate: only explicit lossy projection of selected
   completed dimensions to an existing target, with scorer/version provenance.
   Do not coerce errors/inconclusive results into score zero or auto-write
   feedback. Define human labels as authorized external observations.
9. Specify generic aggregates versus application analysis, sufficient-statistic
   examples, paired identity matching, missing-row reporting and segmentation.
   No corpus metric, automatic release gate or universal analyzer registry.
10. Remove old evaluator entry points and stale declared telemetry from the
    target API. Reconcile readiness evidence; materialize exact downstream
    implementation ticket scopes/test IDs from the revised contracts. No
    backward-compatibility/migration/deprecation work.

Verification: `git diff --check` in `ai-harness`; the applicable spec readiness
checker and semantic review must report no unresolved evaluation blockers;
run the two PURISTA audits in the command table below. Record actual commands
and outputs, including any checker limitation—never mark an unrun check passed.
Require a coverage map from every decision above to types, behavior, tests and
tickets. This ticket ends with revised specs, not runtime edits.

## REV-002 — Freeze handbook and example contracts

Read workspace `specs/50-handbook/00-information-architecture.md` and
`plans/handbook-refactor/implementation-plan.md` in full. Plan amendments to
the existing Harness Test and evaluate section, not a second handbook.

Write scope: those workspace planning/IA documents, this delivery plan, and an
evaluation coverage record under `ai-harness/plans/`. Public page editing waits
for working examples. Freeze final routes and ownership for the pages in the
direction document; map all seven requested recipes to individual tickets.

Use a shared example workspace `ai-harness/examples/practical-evaluations/`
with small recipe directories, test fixtures, a common report format and an
explicit live-model opt-in. Freeze exact files, workspace scripts and expected
outputs before code dispatch. Do not add a vendor-specific environment variable
or model default to generic core. Every recipe must show a failure, a targeted
change, and the limits of the resulting evidence.

Acceptance: no required recipe has an unplanned helper dependency; routes map
to `purista/web/src/data/handbook-content-manifest.ts` and
`purista/web/src/data/navigation.ts`; no empty placeholder pages. Use current
routes where useful, replace obsolete content cleanly without compatibility
aliases or a migration section. Verification: IA/coverage semantic review,
`git diff --check`, PURISTA knowledge/skills audits.

## Runtime delivery tickets — future implementation only

### REV-101 — Execute, re-score and clean up in one vertical slice

Scope: `packages/harness/src/eval/`, its existing public exports/type tests,
and narrowly enumerated error changes from REV-001. Match the repository's
strict TypeScript, HarnessError and Vitest patterns; add TypeDoc-ready examples.

Deliver preflight validation, shared scoring engine, deterministic terminal
matrix, trial identity, bounds, evidence, errors and aggregates. Delete old
helper/types/callers in the same clean-break delivery; do not expose a
half-working public replacement. Preserve declared scorer/dimension order.

Acceptance tests: multiple candidates/cases/trials/scorers; no reference
leakage; re-score executes no task; original timing absent when unknown;
N/A/inconclusive versus crash; deterministic rows under reordered completion;
all timeout/cancel/fail-fast paths; retry does not respond to low scores;
duplicate IDs/oversized input rejected before side effects; bounded active
callbacks; late completions ignored; bounded evidence; segment counts sum.
Verification: Harness typecheck, focused eval tests, type tests, failure and
contract tests from the command table. Match obsolete-symbol checks to the
actual removal list frozen by REV-001.

### REV-102 — Existing accounting and optional OpenTelemetry

Scope: eval runtime, `models/registry.ts`, `ports/model-provider.ts`,
`sessions/index.ts`, `harness/defineHarness.ts`, telemetry modules and focused
tests only where REV-001 explicitly requires changes. Shared runtime changes
must be independently reviewable from concurrent sandbox work.

Acceptance: no collector required for usable results/model accounting; model
aliases and resolved identities retained; cache/reasoning breakdowns preserved;
task/judge/re-score provenance separated; unknown versus zero covered; no
parent/child or streaming usage duplication. An injected in-memory OTel
provider proves run/case/scorer/model parentage, async context isolation,
existing flavors, safe error status and no content leakage. A no-SDK test
proves evaluation still works and does not fabricate trace IDs. Vendor or
exporter errors must not silently change quality verdicts. Verification:
telemetry-flow, eval, model and session tests; public types; integration suite.

### REV-103 — Two scorer adapters that establish extensibility

Scope: public deterministic helper if selected by REV-001; otherwise reference
adapters, calibration fixtures and tests under `examples/practical-evaluations/`.

Demonstrate predicate checks, injected schema validation, and a model-backed
structured rubric with caller-selected input projection. Use a configured
Harness model handle so ordinary model tracking works. No task tool permissions
in the judge. The same adapters must work in execute-and-score and score-only
paths. Test malformed verdict, inconclusive evidence, adversarial instructions,
abort, model failure, changed model/rubric versions and bounded explanation.
Stub tests prove mechanics, not judge validity; provide opt-in calibration
against curated human labels. No universal agreement threshold. Verification:
example typecheck/tests and Harness type tests; optional live validation is
separate and requires credentials/budget, never part of default tests.

### REV-104 — Honest analysis and comparison

Scope: pure analysis/report fixtures in the practical-evaluations example;
generic result aggregation only as frozen by REV-001.

Test confusion matrices, micro/macro F1 and zero denominators from hand-counted
fixtures; all-success and no-success datasets; coverage changes; unmatched
baseline rows; per-segment regressions; separate task/judge cost, partial
accounting and currencies. Do not average sentence BLEU into corpus BLEU or
call arbitrary numeric averages a quality score. Compare fixed identities and
show scorer-version incompatibility instead of hiding it. Verification:
example tests with exact expected reports, typecheck and lint.

## Cookbook tickets — code-backed handbook, not metric catalog pages

Common future write scope: the named recipe directory in
`ai-harness/examples/practical-evaluations/`, its tests, and the corresponding
page(s) under `purista/web/src/content/handbook/harness/test-and-evaluate/`.
Only the designated navigation owner edits shared manifest/navigation files.
Exact routes/files must come from REV-002 before dispatch.

REV-201 additionally owns the evaluation sections in
`ai-harness/packages/harness/README.md`, `ai-harness/docs/reference/public-api.md`,
`ai-harness/docs/guides/testing.md`, `ai-harness/docs/guides/evaluating-prompts.md`,
and their links in `ai-harness/docs/README.md` and `ai-harness/docs/guides/README.md`.
Replace obsolete examples and keep package-local API/build evidence concise;
link the canonical handbook for the full learning path. These files currently
advertise the APIs removed by REV-101 and must not remain stale at release.

| Ticket | Required recipe deliverable and acceptance fixture |
| --- | --- |
| REV-201 | Beginner concepts, first classification run, weak baseline, minority-class regression, confusion matrix, revised candidate and report interpretation; offline and opt-in model paths visibly distinguished. Replace old prompt-helper guidance and package references. |
| REV-202 | Extraction: schema pass with semantically wrong field; absent/null/extra entity cases; normalization/alignment rules; per-field counts and document-level success. |
| REV-203 | RAG: frozen local corpus/index configuration, ranked IDs, missing retrieval versus unsupported answer, wrong citation, unanswerable case; independent retrieval/generation/end-to-end reports. |
| REV-204 | Translation: two valid phrasings, altered negation, terminology and placeholder failures; language/domain segments; optional external corpus metric with pinned configuration, no Python dependency in Harness core. |
| REV-205 | Agent loop: isolated fixture, selected bounded tool facts, unauthorized-call and false-success examples; overflow makes evidence incomplete; task effects verified independently. |
| REV-206 | Subagent-as-tool: child contract checks and parent suite; failed delegation, incomplete child response and synthesis loss; combined model usage without double counting. |
| REV-207 | Workflow: application-owned state/checkpoints, approval/branch/resume fixtures and duplicate-effect case; deterministic invariant tests distinguished from probabilistic quality trials. |
| REV-208 | Case design, judge calibration, reference leakage, holdouts, trials versus retries, uncertainty, paired comparisons, production-to-cases loop, CI policy, privacy, optional OTel/model/cost guide and score-only tutorial. |

Each ticket must include all elements of the common recipe contract in the
direction document, maintained runnable code, exact expected offline output,
and an actionable diagnosed failure. No invented SDK exports in snippets.
Verification: example scripts frozen by REV-002, handbook/knowledge/skills
audits, website build, and rendered route/link/next-step inspection. Do not
assert live model quality from offline fixture tests. Core completeness does
not excuse an unfinished committed recipe.

REV-201 also runs this scan from `ai-harness`, expecting no matches in active
package documentation (historical plans/spec removal lists are not scanned):

```sh
rg -n 'evaluatePromptCandidates|evaluateDeterministicScorer|DeterministicScorerDefinition|EvaluatePromptCandidatesInput' docs packages/harness/README.md
```

## Optional platform tickets

REV-301 first creates an application-only mapping fixture for scalar verdicts,
scorer/version identity, correlation, inconclusive/errors, privacy and repeat
submission identity. Then build the Langfuse example in its own workspace.
Show the difference between trace export and score/experiment submission.
Local data must not be advertised as automatically creating a hosted dataset
comparison. Pin SDK versions and verify frozen dataset provenance.

REV-302 and REV-303 reuse the fixture but have separate example workspaces and
handbook pages for Phoenix and Datadog. Validate their current TypeScript/API
interfaces, attribution, trace-ID conversion and supported backend setup. Keep
the existing application OTel provider; never install a competing global one
silently. Phoenix's trace-query example needs explicit ingestion/completeness
handling. Datadog's site/product availability and payloads need fresh verification.

All three demonstrate exactly one scheduler: Harness-owned execution plus
export, or platform-owned execution reusing task/scorer callbacks. No nested
matrix runner. Stub contract tests require no vendor account; opt-in live smoke
tests include flush/shutdown, export failure and idempotent retry. Import graphs
must contain no vendor SDK in `packages/harness`. Dataset UIs, annotations,
retention and dashboards remain external.

## REV-500 — Completion gate and follow-ups

Required for the core/cookbook release: REV-001 through REV-208, including all
seven recipe tickets. Review each user-facing claim against executable code;
check cleanup of old APIs/docs, public TSDoc, privacy boundaries, untracked
cost disclosure, no OTel setup requirement and no hidden vendor dependencies.
Record optional vendor slices as delivered or deferred without holding the
generic release hostage. Run the full appropriate package/website checks.

REV-401 adds summarization/rewriting; REV-402 adds fixed-transcript conversation
and memory evaluation. Text-to-SQL/code execution is an explicit later design
item needing isolated-environment rules. No specialized helper package is a
prerequisite for teaching the seven committed recipes.

## Verification command inventory

Commands below were verified in package scripts; implementation tests/builds
were not run in this planning pass. New example scripts must be frozen by
REV-002, not guessed by an executor.

| Working directory | Command | Expected result when delivered |
| --- | --- | --- |
| `ai-harness` | `npm run typecheck --workspace @purista/harness` | Exit 0; no type errors. |
| `ai-harness` | `npm run test --workspace @purista/harness -- src/eval` | All scoped eval tests pass. |
| `ai-harness` | `npm run test:types` | Public positive/negative type tests pass. |
| `ai-harness` | `npm run test:contracts` | Contract suite passes. |
| `ai-harness` | `npm run test:failure` | Failure suite passes. |
| `ai-harness` | `npm run test:integration` | Harness integration and quickstart pass. |
| `ai-harness` | `npm run verify:architecture` | Capability/import architecture check passes. |
| `ai-harness` | `npm run lint` and `npm run build` and `npm test` | Full release checks pass; build is future implementation verification only. |
| `purista` | `npm run audit:skills` | No skill drift errors. |
| `purista` | `npm run audit:knowledge` | Knowledge contract checks pass. |
| `purista` | `npm run audit:handbook` | Coverage/navigation checks pass. |
| `purista` | `npm run build -w @purista/web` | Website builds after content changes. |
| Each touched repo | `git diff --check` | No whitespace errors. |

Audit success does not prove statistical validity, live vendor compatibility
or approval of unreviewed API changes. Record those separately.

### Planning-pass verification, 2026-08-26

- `npm run audit:skills` in `purista`: passed, three canonical skills checked.
- `npm run audit:knowledge` in `purista`: passed.
- `git diff --check` in `ai-harness`: passed; the four changed/untracked
  planning documents were also checked directly for trailing whitespace.
- Local Markdown target check across those four documents: 16 links, no
  missing targets.
- Cold read-only plan review: two handoff issues found and repaired—REV-103
  now depends on the example contract, and REV-201 owns package/reference
  documentation cleanup explicitly. No remaining material finding reported.
- No source, public handbook, canonical spec or readiness file edited in this
  advisory revision. No implementation tests, builds, live judges or vendor
  integrations run. REV-001 is still required before implementation dispatch.

## Stop conditions and maintenance

Stop and revise the ticket if its required API is absent from approved specs;
if shared runtime/spec edits overlap unresolved concurrent work; if accounting
requires guessing model usage/prices; if scorer evidence requires access the
application has not authorized; or if a vendor demands a core dependency or
another global provider. Do not improvise compatibility code or fabricate a
passed verification to continue. An implementation task that fails the same
verification twice must report the actual blocker and scope impact.

Maintain scorer/rubric/data/analysis versions as executable behavior changes.
Recheck primary vendor documentation when updating pinned example packages.
Keep public teaching aligned to implemented APIs, not merely this plan.

Considered and rejected: seven core domain adapter families, a universal metric
engine, built-in annotation/persistence/dashboard services, a price database,
and a new telemetry stack. They increase maintenance without being necessary
to teach or execute the requested evaluations.
