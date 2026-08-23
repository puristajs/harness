# @purista/harness-guardrails

Typed, optional guardrails for the default `@purista/harness` agent loop.

It accepts the portable YAML vocabulary used by NVIDIA NeMo Guardrails for
`models`, `rails.input`, `rails.output`, `rails.tool_input`,
`rails.tool_output`, and `rails.retrieval`. Applications provide the actions
and model aliases explicitly; configuration never creates a provider, loads
Python, executes Colang, starts a server, or opens a vector database.

```ts
const config = await loadGuardrailsConfig('./guardrails')
const rails = defineGuardrails({
  config,
  actions: {
    'block secrets': { evaluate: ({ value }) => containsSecret(value) ? { decision: 'block' } : { decision: 'allow' } }
  }
})

const harness = defineHarness()
  .models({ assistant: { provider, model: 'gpt-5-mini', capabilities: ['object'] } })
  .agents({ support: rails.attach({ model: 'assistant', instructions: 'Help safely.', builtinTools: false }) })
  .build()
```

Rail actions return `allow`, `block`, or a phase-appropriate `transform`.
They are ordered, have a 10-second fail-closed evaluation budget by default,
and support a validated, content-free `reasonCode` for operational diagnosis.
Every evaluation emits an OpenInference `GUARDRAIL` span, a counter, and a
duration metric with the final outcome; blocks remain successful guardrail
evaluations, while failed actions are error spans. Use
`filterRetrievedChunks(chunks, { models, signal, logger })` after
application-owned retrieval; the addon has no vector-store integration.

Unsupported NeMo executable features (`.co`, `actions.py`, `config.py`,
dialog and execution rails) fail at config load/compile time with stable
diagnostics instead of being approximated.
