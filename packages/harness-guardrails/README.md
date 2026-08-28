# @purista/harness-guardrails

Typed, optional guardrails for the default `@purista/harness` agent loop.

Configure rails inline with `defineGuardrails({ config, actions })`. The
exported Zod schema validates the same TypeScript object that the addon
compiles. Applications provide action implementations and direct model aliases
explicitly; guardrail configuration never creates a provider, starts a server,
or opens a vector database.

Use the [runnable composition](../../examples/guardrails/README.md) and its
[typed action map](../../examples/guardrails/src/index.ts). Each action declares
its `phase`; configuration flow names must match actions of that phase. The
example attaches input, tool-input, tool-output, and final-output rails to one
agent alongside a shared governance approval provider.

Rail actions return `allow`, `block`, or a phase-appropriate `transform`.
They are ordered, have a 10-second fail-closed evaluation budget by default,
and support a validated, content-free `reasonCode` for operational diagnosis.
Every evaluation emits an OpenInference `GUARDRAIL` span, a counter, and a
duration metric with the final outcome; blocks remain successful guardrail
evaluations, while failed actions are error spans. Use
`filterRetrievedChunks(chunks, { models, signal, logger })` after
application-owned retrieval; the addon has no vector-store integration.

Output rails run only on a final candidate. Tool-input rails transform wire
arguments before binding schemas/adapters prepare input for policy, approval,
and the handler; tool-output rails run after handler-output validation.
`DecisionBlockedError` and `DecisionEvaluationError` come from core and retain
rail-owned safe evidence. A block does not request approval or suspend a run.
Attached actions honor the enclosing deadline and cancellation; no rail can
undo an effect or inspect opaque provider reasoning. Direct model calls and
custom handlers are outside automatic coverage. See the
[decision guide](../../docs/guides/decisions-and-approval.md) for exact boundaries.

The configuration has only `rails` and `sensitiveData`. `rails` defaults to an
empty object and binds ordered action IDs to input, output, tool-input,
tool-output, or retrieval phases. Sensitive-data policies are explicit,
application-selected values. Harness model aliases, typed agent instructions,
actions, workflows, and application-owned retrieval remain the executable
surface.
