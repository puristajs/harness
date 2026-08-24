# DeLM Shared Context Example

This example shows how to coordinate several AI workers on the same urgent
problem without forcing every observation through one central planner prompt.
The concrete use case is a customer-impacting checkout outage: one worker reads
logs, another checks metrics, another proposes rollback, and another validates a
narrow mitigation.

The issue this solves is common in multi-agent systems. Parallel workers can
move faster, but they often duplicate work, pass around unverified claims, or
lose important findings when a central orchestrator tries to summarize
everything. This example gives the workers a small shared context:

- workers claim tasks independently,
- each worker publishes a compact finding,
- unverified fix summaries are rejected,
- detailed evidence stays available behind references,
- the final recommendation uses only admitted shared context.

The core idea comes from DeLM: treat shared context as a coordination surface,
not just as more prompt text. The harness workflow owns the queue, evidence
packets, admission rules, and durable checkpoint; the model workers focus on
reading their assigned evidence and publishing one structured report.

- DeLM project: <https://yuzhenmao.github.io/DeLM/>
- DeLM repository: <https://github.com/yuzhenmao/DeLM>
- Paper: <https://arxiv.org/abs/2606.10662>

## The Scenario

Checkout failures are spiking for EU customers after the 14:00 deployment. The
workflow launches parallel workers against a small incident task queue:

1. `logs-investigation` finds `payment_authorization_timeout` errors after the
   deploy.
2. `metrics-scope` observes the spike is concentrated in EU card authorization.
3. `rollback-proposal` suggests rolling back, but has no verification. The
   shared-context admission gate rejects it.
4. `timeout-fix` verifies that increasing the payment authorization timeout from
   `800ms` to `1500ms` fixes the reproduction. That `PATCH_SUMMARY` is admitted.

The final answer is built from admitted shared context only. Long evidence stays
behind evidence references and can be unfolded when needed.

The workers are not reasoning from hidden constants. `src/incident-data.ts`
contains the local incident records each worker receives:

- checkout API log snippets,
- regional checkout metrics,
- a rollback runbook note,
- reproduction results for `800ms` and `1500ms` payment authorization timeouts.

## Run It

From the repository root:

```bash
cp .env.example .env
# set OPENAI_API_KEY in .env; OPENAI_MODEL defaults to gpt-5-mini
npm run build --workspace @purista/delm-shared-context-example
npm run start --workspace @purista/delm-shared-context-example
```

Expected output is similar to:

```text
Checkout Incident Investigation

Recommendation: mitigate the checkout outage with increase the payment authorization timeout from 800ms to 1500ms, then monitor EU checkout recovery.

Admitted shared context:
- FACT ctx_0002 (logs-investigation, worker-1): Logs show payment_authorization_timeout errors began after the 14:00 checkout deploy.
- OBSERVED ctx_0004 (metrics-scope, worker-2): Checkout failures are concentrated in EU card authorization; US and wallet flows remain normal.
- PATCH_SUMMARY ctx_0006 (timeout-fix, worker-2): increase the payment authorization timeout from 800ms to 1500ms, then monitor EU checkout recovery.

Rejected reports:
- rejected rollback-proposal from worker-1: patch_summary_requires_verified_evidence

Durable workflow checkpoints written: 1
```

The runnable CLI uses the real OpenAI provider by default:

- `OPENAI_API_KEY` is read from the shell environment or repository `.env`.
- `OPENAI_MODEL` defaults to `gpt-5-mini`.

The tests inject `ScriptedDelmProvider`, so CI and local unit tests do not need
network access or an API key.

## What To Read First

- `src/scenario.ts` contains the checkout incident story, task queue, and CLI
  formatter.
- `src/incident-data.ts` contains the concrete log, metric, runbook, and
  reproduction records used by the workers.
- `src/harness.ts` shows how the scenario is wired into `defineHarness()`.
- `src/shared-context.ts` is the reusable admission/digest/unfolding layer.
- `src/task-queue.ts` is the dependency-aware claim/complete queue.
- `src/scripted-provider.ts` makes tests deterministic; `npm start` uses
  `@purista/harness-openai` unless a provider is injected in code.

## What It Demonstrates

- A decentralized FIFO task queue with dependency-aware claiming.
- A shared context store with compact entries and backing evidence records.
- Admission rules that reject unverified `PATCH_SUMMARY` reports.
- Compact digest rendering that avoids leaking long evidence details into every
  prompt.
- Selective unfolding when a caller needs the detailed evidence behind one
  shared entry.
- A harness workflow that runs worker agents in parallel rounds and writes a
  durable workflow checkpoint.

The implementation is split so the reusable pieces can later move into a
package such as `@purista/harness-shared-context`:

```text
src/
  scenario.ts          Concrete checkout outage use case
  incident-data.ts     Local logs, metrics, runbook notes, and reproduction data
  schemas.ts           Zod boundaries and shared types
  task-queue.ts        Dependency-aware claim/complete queue
  shared-context.ts    Admission, digest rendering, evidence unfolding
  scripted-provider.ts Hermetic deterministic provider used by tests
  harness.ts           defineHarness() composition and workflow
  index.ts             Public exports and runnable demo
  index.test.ts        Primitive and workflow tests
```

## Verification

```bash
npm test --workspace @purista/delm-shared-context-example
npm run typecheck --workspace @purista/delm-shared-context-example
npm run build --workspace @purista/delm-shared-context-example
```

## Design Notes

The shared context has two data layers:

- `SharedEntry`: compact prompt-safe gist visible in digests.
- `EvidenceRecord`: longer detail kept behind `unfold(entryId)`.

That mirrors the DeLM paper's emphasis on compact shared context plus selective
unfolding. The admission gate is deliberately deterministic in this example:
a `PATCH_SUMMARY` must include at least one verified evidence record. In a real
application, the gate should be domain-specific and may combine deterministic
checks, evaluator agents, test results, provenance, or human approval.

The harness core is not changed. The pattern lives in workflow/application code
because current harness boundaries intentionally keep product queues, datasets,
and coordination policy outside core unless they become stable ports.

## Limits

- The task queue is in-memory and single-process.
- The shared context store is in-memory and scoped to one workflow run.
- The CLI uses OpenAI, while tests inject a scripted provider for deterministic
  assertions.
- The admission gate proves the shape of the design, not benchmark quality.

Those limits are deliberate. The example is a clean extraction target, not a
premature framework API.
