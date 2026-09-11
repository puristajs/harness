# Practical evaluations: methods first, a small reusable toolkit

Status: revised product/design direction under standing owner auto-approval;
planning only. Not a claim that the revised API is implemented or that spec 35
has passed readiness review for this expanded scope.

Date: 2026-08-26. Source inspected at Harness commit `c378607`, with unrelated
uncommitted sandbox work present. Research checked on the same date.

Execution index: [revision and delivery tickets](./2026-08-26-evaluation-workstream-revision-plan.md).
This supersedes the delivery direction in the
[August 25 evaluation plan](./2026-08-25-generic-evaluation-run-result-implementation-plan.md).
It does not change the separate sandbox workstream.

## Decision

Deliver an evaluation handbook backed by a small provider-neutral toolkit,
not an experiment platform with a short tutorial attached.

The product succeeds when a developer can define success for their application,
build a defensible dataset, measure a baseline, identify a failure, change the
system, and determine whether it improved. Returning a number is insufficient.

Three distinct responsibilities:

```text
versioned cases + candidate + trial
                 |
              execute --------> application-owned observation
                                      |
saved application observations ------> score with interchangeable adapters
                                      |
                           per-case results + coverage
                                      |
                        analyze, compare, inspect, improve
```

Execution and scoring can happen together or separately. Analysis is not
another model invocation. Applications retain control of data, experimental
design, release decisions, and storage. OpenTelemetry export is optional.

## What needs correcting in the earlier plan

These are gaps in the proposed design, not claims of shipped regressions.

| Finding | Evidence in current proposal/source | Required correction |
| --- | --- | --- |
| Practical recipes are deferred behind helpers with no delivery tickets | Old plan EVAL-301 action 5 and follow-up section | Commit all seven requested recipes; use ordinary callbacks before inventing domain helper APIs. |
| Re-scoring requires pretending to execute a task again | Spec 35 `EvaluationScorerTarget` requires task duration/attempts; lifecycle always executes then discards output | Introduce explicit observation input and a score-only path sharing the same scorer engine. |
| An uncertain judge cannot return an honest result | Spec 35 `EvaluationDimensionResult` requires a value for each dimension | Add explicit not-applicable and inconclusive outcomes, distinct from operational errors. |
| Accounting combines candidate work and evaluator overhead | Spec 35 aggregate rules add task and scorer usage; missing values count as zero | Separate task, scoring, and total evaluation cost/duration; track completeness. |
| Trials and corpus analysis are absent | Spec 35 defines execution retries and scalar distributions | Identify independent trials separately; teach counts-based/corpus analysis outside the runner. |
| Ground truth is too easy to leak into the task | Spec 35 `EvaluationTaskTarget` includes `expected` | Give reference answers to scorers, not automatically to the candidate execution callback. |
| Proposed usage drops existing usage details and model attribution | Spec 35 `EvaluationUsage` has only three token fields and cost; existing `TokenUsage` includes cache/reasoning details | Reuse existing normalized usage and model identities; do not create an incompatible accounting vocabulary. |

All findings have high confidence from direct reads. Contract/accounting changes
are medium-risk, medium-sized design changes; the complete cookbook is a large
documentation/examples deliverable. Do not describe the old plan as executable
until these amendments are reconciled into the canonical specs.

## Minimal code responsibility

### One scorer adapter contract

Keep `EvaluationScorer` as an ordinary typed object: stable ID/version, declared
dimensions, and an asynchronous `score` function accepting an AbortSignal.
It can use deterministic predicates, a configured model, an external metric
library, or already-authorized human labels. No base class, registry, plugin
loader, service, or required package per scoring technique.

One adapter may return several dimensions; several adapters may score one
observation. Do not force either one model call per dimension or one combined
judge call. Calibration and cost determine the appropriate arrangement.

The first release must prove both a deterministic adapter and an LLM judge.
For the latter, inject an existing Harness structured-generation model handle
or a provider-neutral invocation function. Make projection, rubric, verdict
schema, and configuration identity explicit. No default vendor/model, hidden
credentials, inherited task tools, automatic prompt optimization, or judge
consensus machinery. Begin with a maintained reference adapter; promote a
factory to public API only if the examples demonstrate repeated boilerplate.

Replace the proposed limited JSON-schema engine with a deterministic predicate
adapter and an injected validator example. Schema validity and semantic
correctness remain different dimensions. Remove obsolete evaluator APIs,
exports, tests and docs in the clean-break implementation; no aliases,
compatibility wrappers, deprecations, or migration layer.

### Execute and re-score without coupling them

Keep a convenience execute-and-score operation. Add a first-class score-only
operation over supplied observations. Names/signatures must be frozen by the
contract revision ticket; this document is design input, not a second API spec.

An observation carries:

- dataset snapshot ID/version, case ID, candidate ID/version, task ID/version,
  trial identity, and an application-owned observation identity;
- typed output plus explicitly selected context/reference material for scoring;
- original execution provenance, when known: time, attempts, model usage,
  cost provenance, Harness run ID and trace/span correlation;
- evidence-completeness information when the output is derived from a bounded
  event stream or a partial external record.

The generic output type can be a label, extracted object, answer with retrieved
document IDs, tool facts, delegation facts, or verified final state. These are
application schemas, not seven mandatory core types. Candidate execution does
not automatically receive scorer references. Safe public context and hidden
grading context must be distinguished.

In score-only mode, unknown original latency/model/cost stays unknown. File
loading time is not original system latency. Re-scoring creates a new scoring
run linked to the same observation; it neither re-executes the task nor
overwrites the old verdict. Core never loads an opaque output/evidence ref.

Raw observations remain application-owned and can be sensitive. Core retains
them only as needed for the current operation; report serialization does not
silently include input, reference, context, candidate secrets, or output.
Applications can capture observations in their task wrapper for later scoring.
No automatic persistence, result-store port, or dataset loader is necessary.

### Honest outcomes, ordering and execution controls

Retain bounded concurrency, cancellation, task/scorer/run deadlines, explicit
continue/fail-fast policy, safe errors, bounded evidence and deterministic
terminal rows. A low score is not an execution exception or a retry trigger.

Add per-dimension outcomes: scored, not applicable, and inconclusive. Keep
these separate from task abstention, scorer crash, malformed judge output,
timeout, and work skipped by cancellation/failure policy. A label named
"unknown" is not a substitute for a typed inconclusive result.

Coverage reports must expose planned, executed, scored, not-applicable,
inconclusive, failed, and skipped counts with explicit denominators. Never
drop difficult cases to improve a pass rate. Applications choose whether an
inconclusive result blocks release. Numeric means are descriptive, not a
universal quality score; dimension definitions state units, direction and
whether averaging is meaningful.

Use explicit trial identity, not duplicate candidate IDs or retries. Proposed
minimal run option: a bounded positive trial count, default one. A row is a
candidate/case/trial tuple; retry attempt is a different field. The application
resets mutable environment/session state per trial in a cleanup-safe fixture.
An ID or temperature zero does not establish statistical independence.

Canonical execution results follow candidate declaration, case declaration,
then trial order; scorer/dimension order follows declaration, not completion.
Score-only results preserve validated observation input order. The scheduler
must cap total work across trials and preserve terminal rows after cancellation.
Timeout ends waiting; it cannot forcibly terminate arbitrary JavaScript or
undo a remote side effect. Ignore late results and bound cleanup explicitly.

### Analysis: useful, but not a second framework

Generic core aggregates cover operational counts, coverage and well-defined
per-dimension distributions/segments. Pure example utilities handle confusion
matrices, counts-based precision/recall/F1, matched baseline comparisons and
task-specific reports. External libraries can calculate corpus metrics.

For example, compute extraction micro-F1 from summed TP/FP/FN; macro-F1 is
computed over the declared classes, with a documented zero-denominator rule.
A mean of individual case F1 scores is not either definition. Corpus BLEU is
not the average of sentence BLEU. See the primary
[classification metric definitions](https://scikit-learn.org/stable/modules/model_evaluation.html)
and [SacreBLEU reference](https://github.com/mjpost/sacreBLEU/blob/master/README.md).

Keep sufficient statistics in declared numeric/label dimensions or in the
application's protected analysis records, not overloaded evidence text. Bind
analysis output to dataset/candidate/scorer versions and an analysis version.
Comparison must report unmatched identities, failed rows and coverage changes;
do not silently compare only surviving successes. No automatic global weighted
score, statistical-significance engine, optimizer or release-policy DSL in core.

## Optional OpenTelemetry, model tracking and cost

This is reuse of the Harness model/telemetry architecture, not a parallel stack.

Current implementation evidence:

- `packages/harness/src/telemetry/shim.ts`: `TelemetryShim` and
  `OtelTelemetryShim`; core does not initialize an SDK/exporter.
- `packages/harness/src/models/registry.ts`: model alias, provider/model identity,
  model operation duration, token usage and cache/reasoning detail attributes.
- `packages/harness/src/ports/model-provider.ts`: normalized `TokenUsage`.
- `packages/harness/src/sessions/index.ts`: `getRunSummary` reads stored events
  without a collector; its present totals do not express usage completeness
  or per-model groups.
- `specs/14-otel-conventions.md` and `specs/30-guardrails.md`: nested model spans
  own usage; parents do not duplicate token/cost records. Pricing is
  application/backend policy, not a core price table.

The OTel API is currently a package peer dependency; optional means no required
SDK provider, exporter, collector, backend account or telemetry setup to run
evaluations. It does not mean the current package has zero OTel imports.

Required behavior:

1. Local execution and result analysis work without telemetry configuration.
   Use existing shim/options, content policy and semantic flavors. Optional
   collectors/exporters are initialized and shut down by the application only.
2. Use the declared `harness.eval.run`, `harness.eval.case` and
   `harness.eval.scorer` hierarchy. A model-backed scorer's ordinary model
   spans are children of its scorer span. Candidate model spans remain under
   the task execution branch; a scorer parent is not itself an LLM call.
3. Preserve alias plus resolved provider/model identity for every participating
   model, including embedding/reranking and delegated agents where applicable.
   A candidate may use several models; a judge may use a different provider.
   Configuration versions do not substitute for observed resolved identities.
4. Reuse `TokenUsage`, including cache read/write and reasoning details. These
   are breakdowns of totals, not additional tokens to add a second time.
   Programmatic evaluation results must not depend on scraping sampled spans.
5. Keep original task latency/usage/cost, scorer latency/usage/cost, and total
   evaluation wall duration distinct. Sum model work only once; do not add
   parent summaries and their children. Parallel durations are not wall time.
6. Track reported/partial/unknown accounting coverage. An absent bill is not
   zero cost. Failed or cancelled provider calls may still be billable. Any
   explicit estimate records currency, source and pricing version/as-of date;
   no hardcoded prices or invented provider invoices. Group currencies rather
   than convert them implicitly. Non-model costs may be reported separately.
7. Re-scoring keeps original task accounting as provenance, not new spend.
   Changed judge models/rubrics produce new scorer identity and new judge cost.
8. Return valid trace/span correlation when available, absent otherwise. An
   application maps observation IDs to task and scorer correlations explicitly.
   Score-only runs keep old task correlation distinct from the new judge trace.
   No fake trace IDs, forced sampling, automatic trace fetching or high-cardinality
   dataset/case IDs in metrics.
9. Evaluation spans/metrics remain content-free under every capture mode. Use
   existing nested model instrumentation for model/usage tracking; do not copy
   prompts, verdict explanations, output refs, segments or arbitrary metadata
   into evaluation telemetry. Negative quality verdicts leave span status
   successful; technical failures set error status.

A narrowly scoped accounting contract amendment is required: reuse existing
runtime facts but add explicit per-model grouping/completeness where current
summaries cannot provide them. Freeze ownership and call-deduplication before
implementation. Do not invent a separate pricing service or duplicate model
instrumentation inside the evaluation runner.

Bounded evidence is not automatically private. Inline verdict explanations can
contain personal or proprietary text; default examples use synthetic data,
safe reason codes or protected opaque references. Users explicitly choose
what goes to a judge, a saved report and a vendor. These are three different
disclosure decisions. A no-content trace policy does not prevent a model-backed
judge from sending its selected input to that model provider.

## Handbook: a repeatable improvement loop

Canonical public home remains `purista/web/src/content/handbook/harness/test-and-evaluate/`.
The workspace handbook IA and navigation manifest must be amended before new
routes are published; no new top-level handbook or duplicated package handbook.

Recommended learning order:

1. **Understand evaluation:** tests versus empirical quality; define the
   decision, risk, evaluation unit, hard gates and quality/operational measures.
2. **Your first useful evaluation:** a small classification example with a
   deliberately weak baseline, failure inspection, one improvement and rerun.
   Offline fixtures teach mechanics; an opt-in real-model path measures a model.
3. **Build trustworthy cases:** representative and failure-derived samples,
   negative/ambiguous cases, labels, adjudication, deduplication, versioned
   snapshots, temporal leakage, development versus holdout sets and segments.
4. **Choose and validate scorers:** deterministic rules, model rubrics, human
   reference labels, calibration and error analysis; no required annotation UI.
5. **Follow a use-case recipe:** the seven requested recipes below.
6. **Compare and improve:** paired identities, uncertainty, repeated trials,
   task-versus-judge cost/latency, regression triage and explicit CI policy.
7. **Operate safely:** turn authorized/redacted production failures into cases;
   distinguish offline suites, monitoring and online controlled experiments.
8. **Extend and integrate:** custom adapters, re-score saved observations,
   optional OpenTelemetry and optional experiment platforms.

Teach small datasets as a starting diagnostic suite, not statistical proof of
reliability. Explain uncertainty and dependence before prescribing intervals;
no universal sample size, threshold or guaranteed confidence. Repeatedly tuning
against a holdout turns it into development data. Never retry until a model
passes and call that the first-attempt success rate.

Comparable experiments also control model/prompt/tool/corpus configuration,
environment reset, concurrency and candidate execution order. Record supported
seeds without promising provider determinism; avoid systematically testing one
candidate under different load or a later data snapshot. Canonical report
ordering is a serialization guarantee, not deterministic model behavior.

### Common recipe contract

Every recipe supplies a concrete decision question; data/reference schema;
curated pass, fail, ambiguous and edge cases; baseline and revised candidate;
scorer rationale; a runnable maintained TypeScript example; expected report;
coverage/segment analysis; one diagnosed failure and targeted change; rerun;
CI policy; privacy, cost, bias and validity limitations. Link method-specific
references rather than copying a catalog of metrics.

Every example has credential-free fixtures that test the harness/scorer/report
mechanics, and an explicitly enabled configured-model path where meaningful.
Do not present fake output improvement as evidence of live model quality.

### Committed use-case recipes

| Recipe | Observe and measure | Failure the tutorial must demonstrate |
| --- | --- | --- |
| Classification | Label validity, confusion matrix, per-class precision/recall, declared macro/micro F1, abstention and rare-class slices | High accuracy hiding poor performance on an important minority class. |
| Extraction | Valid structure separately from field/entity accuracy; explicit normalization/alignment; TP/FP/FN and all-required-fields-correct | Valid JSON containing incorrect values; missing versus null; extra entities. |
| RAG | Frozen corpus/index/config; ranked retrieved IDs and relevant references; retrieval recall/precision, answer correctness, groundedness, citations, unanswerable inputs | Fluent supported answer that omits the requested fact, and failed retrieval misdiagnosed as generation failure. |
| Translation | Meaning, fluency and terminology with source/context; deterministic numbers/names/placeholders/markup checks; optional external corpus metrics | Valid alternative wording rejected by exact match; changed negation or corrupted placeholder. |
| Agent loop / tool calls | Independently checked effects, permissions, argument constraints, termination, task success and budget; selected tool facts for diagnosis | Agent reports success but the requested state change never happened. |
| Agent calling subagents as tools | Child contract suite plus parent end-to-end suite; handoff fidelity, delegation failures, synthesis and total resource use | Individually correct child outputs combined into an incorrect parent conclusion. |
| Agent workflows | Terminal state, business invariants and named checkpoints; branch, approval, resume and duplicate-effect fixtures | Plausible final text despite an incorrect durable state or duplicated effect. |

RAG dimensions deliberately separate retrieval coverage from answer grounding;
[Ragas recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)
and [faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/)
illustrate why those are different questions. Translation needs contextual
judgment; the [MQM study](https://aclanthology.org/2021.tacl-1.87/) is a useful
reference, not a promise that one judge works for every language/domain.

For agent recipes, prefer verified outcomes and required constraints over an
exact preferred trajectory. Distinguish repeated trials from infrastructure
retries. This follows the task/trial/outcome distinctions in
[Anthropic's agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

Existing `RunEvent` includes tool and delegation identity but also raw content
and `stream.overflow`. Project only required facts, bound capture and mark lost
events. An incomplete transcript cannot establish that a forbidden event never
happened. `testing/recordEvents.ts` is an unbounded test helper, not a production
evaluation recorder. There is no universal durable-step trace in that union;
workflow recipes must obtain explicit state/checkpoint facts from their fixture.

### Useful additions, in priority order

1. Summarization and rewriting: source fidelity, required-fact coverage,
   instruction/style/length constraints. Add after the first seven; it reuses
   judge and grounding techniques. [SummEval](https://aclanthology.org/2021.tacl-1.24/)
   provides an empirical reference for multi-dimensional assessment.
2. Multi-turn support and memory: clarification, context retention, escalation
   and resolution. Start with fixed transcripts; simulated users are a separate,
   versioned experimental component, not equivalent to real customers.
3. Text-to-SQL or executable transformations: isolated read-only fixtures,
   result-set equivalence and resource/authorization checks. Defer executable
   untrusted-code examples until their environment policy is specified.

Safety, robustness, privacy, latency and cost cut across every recipe; do not
hide them in an optional chapter that ordinary users never read.

### Evaluate the judge too

Use adjudicated calibration examples, inspect false positives/negatives by
segment, retain a separate judge validation set, and version rubric, model
configuration, projection, schema and thresholds together. Keep verdicts
structured, explanations bounded, and insufficient evidence explicit. Test
malformed outputs and instruction injection inside the material being judged.

For optional pairwise judgment, blind candidate identity where feasible and
swap presentation order. Position/verbosity/self-preference biases have been
observed in tested judges; benchmark agreement is not a guarantee for a new
domain. [MT-Bench judge study](https://arxiv.org/abs/2306.05685).

## Optional platforms: complement, do not wrap the whole product

Two integration patterns, with exactly one execution scheduler:

- Harness owns the run: an application maps completed results and correlations
  into the platform's external-score/experiment APIs.
- Platform owns the experiment: reuse the task and scorer adapters directly;
  do not start a complete Harness evaluation matrix inside every platform item.

Trace export is not dataset/experiment/score interchange. SDKs, credentials,
dataset import, retention, annotations and dashboards remain application or
optional-example dependencies. Export only deliberately mapped fields; make
repeated score submission idempotent using explicit application identities.

| Example | Demonstrate | Important boundary |
| --- | --- | --- |
| Langfuse, first | Existing Harness traces plus mapped scores; local cases and an optional hosted dataset experiment | Local SDK data does not automatically create a hosted dataset comparison run. The inspected docs say hosted experiments use the latest dataset version; freeze imported provenance and verify the pinned SDK rather than promising version pinning. |
| Phoenix, independent optional example | Existing OTel/OpenInference traces; dataset experiment and re-scoring observations | Current TypeScript docs include separate `runExperiment`/`evaluateExperiment`; sampled or not-yet-ingested traces are not complete grading evidence. Do not replace the application's global provider implicitly. |
| Datadog, independent optional example | Existing operational traces/model attribution plus externally submitted evaluation results | Verify the selected site's product support, current TypeScript/API surface and trace ID encoding; do not promise the same dataset UX as other products. |

Source checks: [Langfuse experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk),
[Phoenix TypeScript experiments](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/experiments),
[Datadog external evaluations](https://docs.datadoghq.com/llm_observability/evaluations/external_evaluations/).
The Datadog page was available through search extracts but full-page fetching
failed during this review; exact API payloads remain an integration-ticket check.
Vendor APIs are rolling documentation; pin versions and reverify at implementation.

## Deliberately not building

No dataset/annotation UI, dashboard, hosted experiment service, prompt optimizer,
vendor registry, universal metric library, pricing database, automatic production
sampling, distributed evaluation scheduler or arbitrary trace-replay engine in
core. No legacy/backward-compatibility work. Human review and specialist metrics
are valid application integrations, not obligations to build those products.

## Audit limits

This is a focused design/source/documentation review, not a full correctness,
security or performance audit of Harness. No model calls, live vendor accounts,
SDK installation, live benchmark, or statistical validation was performed.
The canonical contract/readiness amendments and all implementation remain
tracked work in the linked delivery plan.
