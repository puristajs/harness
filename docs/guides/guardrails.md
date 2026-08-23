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
    'remove-secret-marker': { evaluate: ({ value }) => ({ decision: 'transform', target: 'user_message', value: sanitize(value), reasonCode: 'secret_redacted' }) },
    'redact-answer': { evaluate: ({ value }) => ({ decision: 'transform', target: 'bot_message', value: redact(value), reasonCode: 'pii_redacted' }) },
    'approve-transfer': { evaluate: ({ value }) => isApproved(value) ? { decision: 'allow' } : { decision: 'block', reasonCode: 'approval_required' } }
  }
})

const harness = defineHarness()
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .models({ assistant })
  .agents({ support: rails.attach({ model: 'assistant', instructions: 'Help safely.', tools: ['transfer'] }) })
  .build()
```

Actions return `{ decision: 'allow' }`, `{ decision: 'block', reasonCode? }`, or `{ decision: 'transform', target, value, reasonCode? }`. A transform target must match its phase: `user_message`, `bot_message`, `tool_input`, `tool_output`, or `relevant_chunks`. `reasonCode` is optional, deployment-controlled, lower-case snake case, and may be recorded in content-free traces/logs; never derive it from user input.

Input rails run after the agent input schema parses and before dynamic instructions, the transcript, or a model call. Output rails run after the provider result and before model events, output validation, tool dispatch, or persistence. Tool rails run before side effects and before results go back to the model. Normal Harness permissions and governance remain authoritative and evaluate transformed tool input.

## Retrieval and model checks

Keep retrieval application-owned. Filter already-retrieved JSON-compatible chunks explicitly:

```ts
const safeChunks = await rails.filterRetrievedChunks(chunks, {
  models: ctx.models,
  signal: ctx.signal,
  logger: ctx.log
})
```

The addon automatically creates a global-OTel fallback for standalone retrieval spans; pass a process logger in `defineGuardrails({ observability: { logger } })` or the run-scoped logger above when those decisions must be retained in structured logs. `modelCheckRail({ model, instructions })` provides a model-backed allow/block decision through configured Harness model handles. Its model value resolves through `modelAliases`; it never reads credentials or creates a provider from YAML.

## Compatibility and safety

The first release supports `config.yml`/`config.yaml`, `models`, `instructions`, `prompts`, `custom_data`, and input/output/tool/retrieval rail lists. `config.py`, `actions.py`, `.co` files, dialog rails, execution rails, LangChain, servers, and implicit vector stores are rejected with stable diagnostics rather than silently approximated.

Rail actions time out after 10 seconds by default (override globally with `actionTimeoutMs` or per action with `timeoutMs`) and failures are fail-closed. Every evaluation emits an `evaluate_guardrail {rail.id}` child span with `openinference.span.kind=GUARDRAIL`, rail identity, phase, and outcome (`allow`, `block`, `transform`, or `error`). It also emits `harness.guardrail.evaluations` and `harness.guardrail.duration`; blocks are successful guardrail evaluations (span status `UNSET`) while action failures are span errors. Blocks, transformations, and failures have content-free structured logs.

`modelCheckRail` invokes the registered Harness model handle within that guardrail span. Its nested standard `LLM` model span carries the configured alias/provider/model plus `gen_ai.usage.*` and `llm.token_count.*` when the provider reports usage, and emits the normal `gen_ai.client.token.usage` metric. This deliberate nesting lets observability backends attribute safety-model spend to the exact guardrail without duplicating or inventing token counts on the guardrail span. Pricing remains application/backend policy because model price schedules are not stable telemetry data.

Do not put prompts, completions, documents, tool inputs/results, or credentials into action errors, logs, span attributes, reason codes, or fixtures.
