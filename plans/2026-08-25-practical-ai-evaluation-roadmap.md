# Practical AI evaluation roadmap

Status: research and roadmap proposal, not an approved specification

Follow-up: the [2026-08-26 methods/toolkit direction](./2026-08-26-evaluation-methods-and-toolkit-direction.md)
and [revision/delivery plan](./2026-08-26-evaluation-workstream-revision-plan.md)
now own evaluation planning. This document remains the original research;
deferred-helper and accounting recommendations must be read with those revisions.

Date: 2026-08-25

Audience: PURISTA maintainers, handbook authors, and enterprise application teams

## Decision summary

PURISTA should teach a practical evaluation loop and provide a small,
provider-neutral execution and result layer. It should not build a competing
evaluation SaaS, dataset UI, annotation system, or experiment dashboard.

The recommended boundary is:

- PURISTA/Harness makes application behavior deterministic enough to test,
  exposes safe trace correlations, runs versioned cases and scorers, and returns
  per-case evidence plus aggregates.
- Third-party platforms own large datasets, experiment comparison, dashboards,
  annotation queues, production sampling, and long-term analytics.
- Integration examples use OpenTelemetry where it fits and thin provider SDK
  code for datasets, experiments, and scores. Vendor SDKs do not become Harness
  core dependencies.

The first implementation step is not another specialized metric. It is a sound
generic evaluation result model: stable identities, multiple named scorers,
per-case results, errors, evidence, correlations, bounded concurrency, and
privacy controls. RAG, tool trajectory, workflow, and guardrail helpers can then
build on it.

For documentation, start with one small end-to-end baseline and lead users
through a repeatable improvement loop. Do not begin with an academic catalog of
metrics.

## What exists today

### Useful foundations

- [`packages/harness/src/eval/index.ts`](../packages/harness/src/eval/index.ts)
  provides deterministic regex, contains, attribute-equality, and a limited JSON
  schema scorer plus prompt-candidate comparison.
- [`packages/harness/src/testing`](../packages/harness/src/testing) provides
  fakes, recording utilities, contract tests, replay support, and feedback test
  helpers.
- [`docs/guides/evaluating-prompts.md`](../docs/guides/evaluating-prompts.md)
  correctly presents the current evaluator as a small local helper rather than
  a complete evaluation platform.
- Harness has OpenTelemetry-oriented tracing and declared evaluation conventions
  in [`14-otel-conventions.md`](../specs/14-otel-conventions.md).
- Guardrail packages provide a real domain on which to demonstrate measurement,
  especially false-positive/false-negative behavior and privacy-safe evidence.

### Important gaps

The current prompt evaluator iterates candidates and items serially and returns
only an aggregate `CandidateScore`. It discards candidate metadata, per-case
scores, evidence, errors, timings, and trace/run correlations. A scorer target
also does not receive stable candidate or dataset item identity.

It therefore cannot yet support the practical questions users need to answer:

- Which cases regressed and why?
- Which scorer failed, on which segment, with what evidence?
- Was the model output bad, or did retrieval/tool selection/workflow logic fail?
- Is a candidate better enough to deploy when latency and cost are included?
- Can a production failure be added back to a reproducible dataset?

There are also two immediate drift issues:

- The telemetry specification declares `harness.eval.candidate` spans and a
  candidate score metric, but the implementation does not currently emit them.
- The deterministic-scorer example in [`docs/guides/testing.md`](../docs/guides/testing.md)
  treats a synchronous function like a promise and should be corrected.

Existing `ai-eval-research` notes predate current OpenInference evaluation and
annotation conventions and the dedicated OpenTelemetry GenAI semantic
conventions repository. They remain useful historical proposals but should not
be treated as the current standards conclusion.

## The practical evaluation loop to teach

```text
observe a failure
  -> turn it into a sanitized, versioned case
  -> run a baseline and one candidate offline
  -> score hard requirements and quality separately
  -> inspect failures by segment
  -> gate or review the change
  -> deploy gradually
  -> sample production behavior and human feedback
  -> add new failures to the dataset
```

This loop is more useful to a beginner than “find one universal quality score.”
Each evaluation should answer one explicit release decision.

### A first evaluation in seven decisions

1. **Behavior:** What user-visible behavior are we trying to improve?
2. **Cases:** What 20–50 representative, difficult, and failure-derived examples
   cover that behavior?
3. **Hard gates:** What must never happen: invalid schema, forbidden tool,
   missing citation, leaked sensitive data, or broken workflow invariant?
4. **Quality dimensions:** What two or three subjective properties matter:
   correctness, groundedness, usefulness, tone, or completeness?
5. **Baseline:** What current model/prompt/retriever/workflow configuration is
   the comparison point?
6. **Threshold:** Which hard gates require 100%, and what improvement or
   non-regression is required for quality, latency, and cost?
7. **Production feedback:** What sampled signals or user feedback will produce
   the next dataset cases?

## Evaluation layers

Teams should diagnose the smallest component that can explain the failure, then
also verify the end-to-end outcome.

| Layer | Questions | Practical measures |
| --- | --- | --- |
| Deterministic contracts | Is the output structurally valid and policy-compliant? | Schema, exact/contains/regex, allow/deny lists, required fields, no mutation, state invariants. |
| Final response | Is the answer correct and useful? | Task success, correctness, completeness, rubric score, human preference. |
| RAG retrieval | Did we retrieve the evidence needed to answer? | Recall at K, precision at K, relevance, coverage, reranker gain, latency. |
| RAG generation | Does the answer follow the evidence? | Groundedness/faithfulness, answer correctness, citation validity, unsupported-claim rate. |
| Agent/tool step | Did the agent choose and call the right tool? | Tool choice, allowed tool, argument validity, result handling, error recovery. |
| Agent trajectory | Did the sequence reach the goal safely and efficiently? | Final outcome, exact/unordered/subset trajectory match, redundant calls, step count, cost, latency. |
| Workflow | Did orchestration preserve business rules? | Terminal state, branch decisions, retries, idempotency, compensation, approval boundaries. |
| Guardrail | Does the protection catch risk without breaking valid work? | True/false positives and negatives, bypass rate, transformation integrity, latency, fail-open/closed behavior. |
| Operations | Can this run reliably at the intended scale? | Error/rate-limit rate, p50/p95 latency, tokens, cost, timeouts, resource use. |

### RAG: evaluate retrieval and generation separately

An end-to-end “bad answer” score does not reveal whether the retriever missed the
document, the reranker buried it, or the model ignored it. A useful RAG dataset
therefore needs queries, expected facts or answer, and expected relevant
document/chunk identifiers where available.

Start with deterministic retrieval measures on labeled examples. Add an
LLM-based groundedness or relevance judge only after checking it against a small
human-labeled calibration set. Treat citation format and citation existence as
deterministic gates; citation correctness still needs evidence-aware scoring.

### Agents and tools: outcome, steps, and efficiency

Do not require one exact trajectory unless the business process truly requires
it. For many agents, several call orders are valid. Support at least these
policies:

- exact sequence for regulated or deterministic workflows;
- unordered equality when order does not matter;
- required subset when the agent may take optional diagnostic steps;
- allowed superset bounds to prevent unconstrained extra calls.

Tool names and safe argument projections can be compared deterministically.
Sensitive raw arguments and tool results should not be copied into evaluation
telemetry by default.

### Workflows: business invariants before prose quality

Measure terminal state, durable effects, retry/idempotency behavior,
compensation, and human-approval boundaries. Model-response quality is secondary
when a workflow can double-charge a customer or skip an approval.

### Guardrails: use a confusion matrix

A guardrail that blocks every input has perfect recall and no product value.
Maintain labeled positive, negative, boundary, and adversarial cases, then report
true positives, false positives, true negatives, false negatives, and latency.
For redaction/transformation, also verify that non-sensitive content and data
shape remain useful. Test fail-open versus fail-closed behavior explicitly.

## Scorer strategy

Use the least subjective scorer that can answer the question:

1. deterministic code or contract checks;
2. reference-based comparisons or domain simulators;
3. human review for valuable or ambiguous cases;
4. LLM-as-a-judge for scale after calibration.

An LLM judge should have a narrow rubric, structured output, named score
dimensions, and a recorded judge model/prompt/version. Compare it to a held-out
human-labeled set and review disagreement by segment. For pairwise comparison,
randomize candidate order because judges can have position bias.

Do not collapse hard safety gates, subjective quality, latency, and cost into a
single weighted score. Show them separately and make release policy explicit.

## Dataset minimum

Each case should support:

- stable case ID and dataset/version ID;
- sanitized input and optional reference answer;
- expected facts, document IDs, tool calls, or workflow invariants as relevant;
- controlled context and configuration references;
- provenance: synthetic, curated, incident, user feedback, or production sample;
- tags/segments such as locale, customer tier, task class, and difficulty;
- privacy classification and retention policy;
- split: development, test, holdout, or adversarial;
- creation/update timestamps and a reason for inclusion.

Production examples should be sanitized before dataset ingestion. Secrets and
raw sensitive content must not enter traces, judge prompts, or third-party
platforms merely because an evaluation is running.

## Provider landscape and recommended role

Capabilities below are based on official documentation reviewed on 2026-08-25.
Provider selection must also consider hosting region, data processing terms,
retention, private deployment, SSO/RBAC, and cost.

| Platform | Strengths for this plan | Suggested documentation role |
| --- | --- | --- |
| Langfuse | Datasets/experiments, offline and online evaluation, score types, LLM judges, annotation queues, and a strong observability-to-evaluation loop | First reference for an approachable, evaluation-centered integration; note self-hosting and current-version API behavior. |
| Datadog LLM Observability | Managed/custom judges, feedback and external evaluations, annotation queues, experiments, and correlation with production operations | First enterprise observability integration, especially for teams already using Datadog. |
| Phoenix | Open-source/self-host-friendly observability plus datasets, experiments, deterministic/LLM evaluators, and OpenInference alignment | Reference open/self-hosted path and standards-oriented example. |
| LangSmith | Detailed offline/online, pairwise, RAG, and agent trajectory evaluation patterns | Advanced agent/RAG recipe and conceptual source; useful when teams use LangChain but not required by Harness. |
| Braintrust | Clear data/task/score experiment model, CI workflows, versioned datasets, and production traces-to-dataset loop | Focused experiment/CI alternative for teams prioritizing evaluation workflow. |

No single platform needs first-class core coupling. Publish a common integration
shape, then focused provider pages.

## Proposed Harness roadmap

### P0: repair accuracy and drift

- Decide whether the declared `harness.eval.*` telemetry is current and implement
  it, or mark it as planned until a result model exists.
- Correct the synchronous scorer example in the testing guide.
- Update standards notes for OpenInference evaluation/annotation conventions and
  the dedicated OpenTelemetry GenAI semantic conventions repository.
- State clearly that the current helper is aggregate-only and local.

### P1: provider-neutral evaluation substrate

Design an approved generic evaluation API rather than extending only prompt
candidates. It should support arbitrary tasks such as a prompt, agent run,
workflow, retriever, guardrail, or tool step.

Minimum result model:

- stable run, dataset, case, candidate, task, and scorer IDs;
- named and versioned scorers with multiple dimensions;
- per-case output reference, score/label/pass state, bounded evidence or evidence
  reference, error, and duration;
- run/trace correlation plus optional token/cost data;
- aggregate statistics by candidate, scorer, and declared segment;
- bounded concurrency, cancellation, timeout, and explicit retry/failure policy;
- deterministic ordering of persisted and returned results;
- content-safe telemetry with raw inputs/outputs disabled by default.

Keep dataset storage, experiment UI, annotation queue, and judge hosting outside
Harness core. A small provider-neutral `EvaluationReporter` or `EvaluationSink`
port may be justified after the result schema is proven. Reconcile it with the
existing `FeedbackRecord` types instead of creating a parallel feedback model.

### P2: practical domain helpers

Build only helpers that remove repeated, error-prone code:

- trajectory projection and exact/unordered/subset/superset comparison;
- retrieval ranking measures and evidence-aware result fields;
- workflow state/invariant scorers;
- guardrail confusion-matrix summaries;
- regression comparison against a frozen baseline.

LLM judge prompts, proprietary metrics, and changing platform workflows belong
in examples or provider integrations unless a stable generic contract emerges.

### P3: integration examples

Publish and test TypeScript examples in this order:

1. Langfuse: dataset -> Harness task -> per-case scores -> experiment result,
   plus production trace/feedback correlation.
2. Datadog: Harness spans -> LLM Observability, external evaluation attachment,
   and an experiment or annotation workflow.
3. Phoenix: OpenTelemetry/OpenInference-oriented local or self-hosted evaluation.
4. One specialized workflow comparison using LangSmith or Braintrust.

Each example should keep vendor imports in the example package and make the
provider-neutral task/scorer boundary visible.

## Handbook information architecture

Expand the current “Test and evaluate” area into a guided learning path:

1. **Evaluation in one hour** — baseline, 20 cases, hard checks, one quality
   rubric, comparison, and a CI decision.
2. **Build and version a useful dataset** — representative, difficult,
   failure-derived, holdout, adversarial, and privacy-safe cases.
3. **Choose scorers and calibrate judges** — deterministic, human, and
   LLM-based scoring with clear tradeoffs.
4. **Test deterministically with Harness fakes** — models, tools, storage,
   memory, sandboxes, replay, and contracts.
5. **Evaluate prompts and final responses** — multiple candidates and dimensions.
6. **Evaluate RAG systems** — retrieval, generation, citations, and diagnosis.
7. **Evaluate agents and tool calls** — outcomes, arguments, trajectories,
   efficiency, and safety.
8. **Evaluate durable workflows** — state, branches, retries, compensation, and
   approvals.
9. **Evaluate guardrails** — confusion matrices, adversarial cases, transformation
   quality, and latency.
10. **Gate changes in CI** — frozen baselines, thresholds, uncertainty, flaky
    dependencies, and artifacts.
11. **Evaluate production safely** — sampling, user feedback, human review,
    incident-to-dataset flow, privacy, and cost.
12. **Connect an evaluation platform** — capability hub leading to focused
    Langfuse, Datadog, Phoenix, and optional LangSmith/Braintrust pages.

### Required shape of every use-case page

- the release or improvement question;
- the smallest useful dataset schema;
- hard gates versus quality and operational measures;
- a runnable TypeScript example;
- example per-case and summary output;
- how to inspect and segment failures;
- a conservative CI policy;
- the production feedback loop;
- privacy, security, cost, and judge-calibration warnings;
- a clear next step.

This consistency is especially important for beginner and intermediate users.

## Integration contract for examples

A provider example should demonstrate four explicit mappings:

| Harness concept | Provider concept |
| --- | --- |
| Task invocation with frozen app/model/prompt configuration | Experiment task/candidate |
| Versioned cases and segment tags | Dataset and examples/items |
| Named per-case scores and bounded evidence | Evaluation/score/feedback records |
| Run/trace/session correlation | Production trace or experiment observation |

The example must state which content leaves the application, how to disable raw
content capture, and where retention and access control are configured.

## Success measures for this roadmap

- A beginner can create a small baseline evaluation and interpret failures from
  one tutorial without selecting a platform first.
- One evaluation run can report multiple per-case scorer results and trace the
  failure back to a Harness run without exposing raw content by default.
- The same task and dataset can be used with a local reporter and at least two
  third-party integrations.
- RAG, agent/tool, workflow, and guardrail examples diagnose component failures,
  not only end-to-end quality.
- CI examples separate non-negotiable gates from quality, latency, and cost.
- Production feedback can become a sanitized, versioned regression case.
- Documentation makes calibration, privacy, retention, and cost obligations
  visible before users enable online judges or content capture.

## Primary sources

- [Langfuse evaluation core concepts](https://langfuse.com/docs/evaluation/core-concepts)
- [Langfuse LLM-as-a-judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge)
- [Langfuse annotation queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)
- [Langfuse Experiments API](https://langfuse.com/docs/api-and-data-platform/features/experiments-api)
- [Datadog LLM Observability evaluations](https://docs.datadoghq.com/llm_observability/evaluations/)
- [Datadog LLM Observability experiments](https://docs.datadoghq.com/llm_observability/experiments/setup/)
- [Datadog LLM Observability API instrumentation](https://docs.datadoghq.com/llm_observability/instrumentation/api/)
- [LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types)
- [LangSmith agent trajectory evaluation](https://docs.langchain.com/langsmith/trajectory-evals)
- [LangSmith evaluation approaches](https://docs.langchain.com/langsmith/evaluation-approaches)
- [LangSmith judge calibration](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback)
- [LangSmith pairwise evaluation](https://docs.langchain.com/langsmith/evaluate-pairwise)
- [Braintrust evaluation model](https://www.braintrust.dev/docs/evaluate)
- [Braintrust versioned datasets](https://www.braintrust.dev/docs/guides/datasets)
- [Phoenix overview](https://arize.com/docs/phoenix/)
- [Phoenix evaluator traces](https://arize.com/docs/phoenix/evaluation/llm-evals/evaluator-traces)
- [Phoenix experiments](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/run-experiments)
- [OpenInference semantic conventions](https://arize-ai.github.io/openinference/spec/semantic_conventions.html)
- [OpenInference annotations and evaluation results](https://arize-ai.github.io/openinference/spec/annotations.html)
- [OpenTelemetry GenAI semantic conventions repository](https://github.com/open-telemetry/semantic-conventions-genai)
- [OpenTelemetry GenAI attribute registry](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/gen-ai.md)
- [OpenTelemetry GenAI evaluation span discussion](https://github.com/open-telemetry/semantic-conventions-genai/issues/33)
