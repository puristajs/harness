# Guardrails

`@purista/harness-guardrails` is an optional, typed addon for default-loop agents. It adapts the portable configuration vocabulary from NVIDIA NeMo Guardrails without importing a Python runtime, Colang, provider SDK, server, or vector database.

## Install and configure

```sh
npm install @purista/harness @purista/harness-guardrails
```

```yaml
models:
  - type: main
    engine: harness
    model: assistant
rails:
  input:
    flows: [remove-secret-marker]
  output:
    flows: [redact-answer]
  tool_input:
    flows: [approve-transfer]
```

```ts
const rails = defineGuardrails({
  config: await loadGuardrailsConfig('./guardrails'),
  modelAliases: { main: 'assistant' },
  actions: {
    'remove-secret-marker': { evaluate: ({ value }) => sanitize(value) },
    'redact-answer': { evaluate: ({ value }) => redact(value) },
    'approve-transfer': { evaluate: ({ value }) => approve(value) }
  }
})

const harness = defineHarness()
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .models({ assistant })
  .agents({ support: rails.attach({ model: 'assistant', instructions: 'Help safely.', tools: ['transfer'] }) })
  .build()
```

Actions return `{ decision: 'allow' }`, `{ decision: 'block' }`, or `{ decision: 'transform', target, value }`. A transform target must match its phase: `user_message`, `bot_message`, `tool_input`, `tool_output`, or `relevant_chunks`.

Input rails run after the agent input schema parses and before dynamic instructions, the transcript, or a model call. Output rails run after the provider result and before model events, output validation, tool dispatch, or persistence. Tool rails run before side effects and before results go back to the model. Normal Harness permissions and governance remain authoritative and evaluate transformed tool input.

## Retrieval and model checks

Keep retrieval application-owned. Filter already-retrieved JSON-compatible chunks explicitly:

```ts
const safeChunks = await rails.filterRetrievedChunks(chunks)
```

`modelCheckRail({ model, instructions })` provides a model-backed allow/block decision through configured Harness model handles. Its model value resolves through `modelAliases`; it never reads credentials or creates a provider from YAML.

## Compatibility and safety

The first release supports `config.yml`/`config.yaml`, `models`, `instructions`, `prompts`, `custom_data`, and input/output/tool/retrieval rail lists. `config.py`, `actions.py`, `.co` files, dialog rails, execution rails, LangChain, servers, and implicit vector stores are rejected with stable diagnostics rather than silently approximated.

Rail action failures are fail-closed. Guardrail spans use the Harness telemetry shim with `openinference.span.kind=GUARDRAIL` and contain only rail identity and phase. Do not put prompts, completions, documents, tool inputs/results, or credentials into action errors, logs, span attributes, or fixtures.
