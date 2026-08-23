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
They are ordered and fail closed. The addon emits content-free `GUARDRAIL`
spans through the configured Harness telemetry shim. Use
`filterRetrievedChunks(...)` after application-owned retrieval; the addon has
no vector-store integration.

Unsupported NeMo executable features (`.co`, `actions.py`, `config.py`,
dialog and execution rails) fail at config load/compile time with stable
diagnostics instead of being approximated.
