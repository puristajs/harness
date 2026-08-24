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

## Sensitive data: portable policy, injected detector

Sensitive-data rails are configured in the compatible NeMo-shaped YAML subset,
but detector choice remains an application composition-root decision. Install
the base addon and exactly one optional detector package:

```sh
npm install @purista/harness-guardrails
# Original Presidio Analyzer behind your authenticated internal gateway
npm install @purista/harness-guardrails-presidio
# Or the local deterministic Rust/Node-API subset for Node.js and Bun
npm install @purista/harness-guardrails-native-privacy
```

```yaml
rails:
  config:
    sensitive_data_detection:
      input:
        entities: [EMAIL_ADDRESS, PHONE_NUMBER]
        mask_token: '<MASKED>'
        score_threshold: 0.6
      output:
        entities: [EMAIL_ADDRESS]
        mask_token: '<MASKED>'
        score_threshold: 0.6
      retrieval:
        entities: [EMAIL_ADDRESS]
        mask_token: '<MASKED>'
        score_threshold: 0.6
  input:
    flows: ['mask sensitive data on input']
  output:
    flows: ['detect sensitive data on output']
  retrieval:
    flows: ['mask sensitive data on retrieval']
```

Bind the detector to the built-in action factory; policy YAML never carries an
endpoint, credentials, language, recognizer configuration, or provider name.

```ts
import { createSensitiveDataActions, defineGuardrails, loadGuardrailsConfig } from '@purista/harness-guardrails'
import { createPresidioDetector } from '@purista/harness-guardrails-presidio'

const detector = createPresidioDetector({
  id: 'presidio-private',
  endpoint: 'https://presidio.internal/',
  headers: { authorization: process.env.PRESIDIO_GATEWAY_TOKEN! },
})

const rails = defineGuardrails({
  config: await loadGuardrailsConfig('./guardrails'),
  actions: createSensitiveDataActions({ detector }),
})
```

Detect flows block with `sensitive_data_detected`; mask flows replace only
validated matches with `mask_token` and use `sensitive_data_masked`. Malformed
results, detector failures, cancellation protocol failures, or codec faults
fail closed. Neither matched text nor offsets cross the detector contract or
appear in operational evidence.

### Detector choices

| Package | When to choose it | Entity coverage and runtime |
| --- | --- | --- |
| `@purista/harness-guardrails-presidio` | You require Presidio recognizers such as `PERSON`, custom deployment-side recognizers, or Presidio language support. | Calls only original Presidio `POST /analyze` through an injected internal HTTP(S) endpoint. It sends `return_decision_process: false`, validates every result, and converts Python code-point offsets to JavaScript UTF-16 indexes. Deploy the upstream service behind application-owned authentication; it has no built-in public-service security boundary. |
| `@purista/harness-guardrails-native-privacy` | You need a local dependency with no detector network hop. | Deterministic first-release subset: `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IP_ADDRESS`, `IBAN_CODE`, `US_SSN`, `URL`. One Node-API prebuild family is tested on Node.js and Bun for macOS, Linux glibc, and Windows. Missing platform artifacts fail during construction; there is no JavaScript, WASM, model, or remote fallback. |

The native package rejects unsupported configured entities at construction. It
is not a Presidio or NER/ML port. Use Presidio or another injected
`SensitiveDataDetector` implementation when the policy requires entities such
as people, organizations, locations, or custom recognizers.

### What can I do with each detector?

This matrix describes the current product behavior. “Deployment recognizer
dependent” means the application-owned Presidio Analyzer deployment must
already contain the relevant recognizer or model; this adapter neither installs
nor configures it.

| I want to… | Presidio sidecar | Native privacy |
| --- | --- | --- |
| Block PII before it crosses an agent, model, tool, or retrieval boundary | Yes | Yes |
| Replace each detected whole value with a fixed configured token | Yes | Yes |
| Remove each detected whole value | Yes, use an empty `mask_token` | Yes, use an empty `mask_token` |
| Detect an email address | Deployment recognizer dependent | Built in, regex-based |
| Detect a phone number | Deployment recognizer dependent | Built in, format-based |
| Detect a payment-card number | Deployment recognizer dependent | Built in, Luhn-checked |
| Detect an IPv4 address | Deployment recognizer dependent | Built in, IPv4 only |
| Detect an IPv6 address | Deployment recognizer dependent | Not supplied |
| Detect an IBAN | Deployment recognizer dependent | Built in, IBAN-shaped format |
| Detect a US Social Security number | Deployment recognizer dependent | Built in, US-SSN-shaped format |
| Detect an HTTP(S) URL | Deployment recognizer dependent | Built in, HTTP(S) only |
| Detect names, locations, organizations, medical entities, or other NER/model entities | Deployment recognizer/model dependent | Not supplied |
| Detect an application-specific identifier | Custom recognizer dependent | Not supplied |
| Choose a detection language | One fixed composition-root language per detector | No NLP language model |
| Keep detector processing in-process with no detector network hop | Not supplied | Yes |
| Protect reviewed text fields inside a structured tool value | Yes, through the same explicit codec | Yes, through the same explicit codec |
| Script deterministic tests | `FakePresidioSidecar` | `FakeSensitiveDataDetector` |

Neither current detector generates realistic replacement data, chooses a
different replacement by entity type, partially masks a value, hashes or
encrypts a value, processes a complete CSV/JSON dataset, redacts image/PDF
OCR, or provides a batch API. Those are separate capabilities, not hidden
sidecar features. In particular, the Presidio adapter intentionally uses only
Analyzer detection; it does not call Presidio Anonymizer.

### Test rails and sidecars deterministically

Use the public testing helpers for unit tests, workflow tests, tool tests, and
adapter contract tests. They do not recognize data or call a network: each
test scripts exactly the findings, failure, or Presidio HTTP outcome it needs.
The request record is test-only and can contain synthetic input, so never send
it to logs, snapshots, or telemetry.

```ts
import { FakeSensitiveDataDetector } from '@purista/harness-guardrails/testing'

const detector = new FakeSensitiveDataDetector({
  supportedEntities: ['EMAIL_ADDRESS'],
})
detector.enqueue([{ category: 'EMAIL_ADDRESS', start: 0, end: 22, score: 0.99 }])

// `createSensitiveDataActions({ detector })` now has one deterministic match.
// The next unscripted inspection returns `{ findings: [] }`.
```

```ts
import { createPresidioDetector } from '@purista/harness-guardrails-presidio'
import { FakePresidioSidecar } from '@purista/harness-guardrails-presidio/testing'

const sidecar = new FakePresidioSidecar()
sidecar.enqueueAnalyzeResponse([
  { entity_type: 'EMAIL_ADDRESS', start: 0, end: 22, score: 0.99 },
])
const detector = createPresidioDetector({
  id: 'presidio-test',
  endpoint: 'https://presidio.test/',
  fetch: sidecar.fetch,
})

// Assert `sidecar.requests[0]` when verifying the exact POST /analyze contract.
// `sidecar.enqueueTransportError()` scripts a safe fail-closed transport failure.
```

### Structured tools need an explicit codec

The portable policy applies to string input, string output, and string
retrieval chunks. A structured tool value is never recursively scanned. Bind a
specific tool flow to a reviewed `SensitiveDataValueCodec` that extracts only
the fields permitted for inspection and reconstructs only those fields after
masking. This keeps tool schemas, authority, and data minimization explicit.

```ts
const actions = createSensitiveDataActions({
  detector,
  toolInput: {
    policy: 'input',
    maskFlow: 'mask transfer memo',
    codec: {
      id: 'transfer-memo-v1',
      extract: (value) => [{ id: 'memo', text: value.memo }],
      replace: (value, replacements) => ({
        ...value,
        memo: applyReplacements(value.memo, replacements.filter((entry) => entry.id === 'memo')),
      }),
    },
  },
})
```

Configure `tool_input.flows: ['mask transfer memo']` and retain normal Zod,
permission, governance, and business-authorization checks. Codec errors fail
closed before the tool side effect.

## Compatibility and safety

The first release supports `config.yml`/`config.yaml`, `models`, `instructions`, `prompts`, `custom_data`, and input/output/tool/retrieval rail lists. `config.py`, `actions.py`, `.co` files, dialog rails, execution rails, LangChain, servers, and implicit vector stores are rejected with stable diagnostics rather than silently approximated.

Rail actions time out after 10 seconds by default (override globally with `actionTimeoutMs` or per action with `timeoutMs`) and failures are fail-closed. Every evaluation emits an `evaluate_guardrail {rail.id}` child span with `openinference.span.kind=GUARDRAIL`, rail identity, phase, and outcome (`allow`, `block`, `transform`, or `error`). It also emits `harness.guardrail.evaluations` and `harness.guardrail.duration`; blocks are successful guardrail evaluations (span status `UNSET`) while action failures are span errors. Blocks, transformations, and failures have content-free structured logs.

`modelCheckRail` invokes the registered Harness model handle within that guardrail span. Its nested standard `LLM` model span carries the configured alias/provider/model plus `gen_ai.usage.*` and `llm.token_count.*` when the provider reports usage, and emits the normal `gen_ai.client.token.usage` metric. This deliberate nesting lets observability backends attribute safety-model spend to the exact guardrail without duplicating or inventing token counts on the guardrail span. Pricing remains application/backend policy because model price schedules are not stable telemetry data.

Each sensitive-data inspection adds a nested
`harness.sensitive_data.inspect` `GUARDRAIL` span plus
`harness.sensitive_data.inspections` and `harness.sensitive_data.duration`.
They contain only detector id, `local|cloud` execution mode,
`detect|mask` operation, outcome, bounded finding count, configured category
identifiers, and an error type on failure. A detector is not an LLM call: it
never emits model, token, `gen_ai.*`, `llm.*`, or cost attributes. If a
model-backed guardrail is also used, its nested normal LLM span remains the one
authoritative token and provider record.

Do not put prompts, completions, documents, tool inputs/results, or credentials into action errors, logs, span attributes, reason codes, or fixtures.

## Default-loop agents, workflows, tools, and skills

`rails.attach(...)` adds one ordered, fail-closed interceptor to a Harness
**default-loop agent**. That is the automation boundary: the normal agent loop
owns model and tool lifecycles, so the addon can safely evaluate all four
interception points.

| Execution path | Coverage | Notes |
| --- | --- | --- |
| Attached default-loop agent input | Automatic | Runs after the input schema and before instructions, history, or a model call. |
| Attached default-loop agent output | Automatic | Runs after each provider result and before output validation, persistence, or tool dispatch. |
| TypeScript, MCP, and built-in tool call input/output | Automatic | `tool_input` runs before permissions, governance, schema validation, and side effects. `tool_output` runs before the result returns to the model. |
| Skill activation | Automatic through the `read` built-in tool | Skills are mounted files. A rail does not scan all skill files at startup; it can govern the `read` call that opens a skill. |
| Workflow calling an attached agent | Automatic for that agent invocation | Workflow and agent spans stay correlated through the normal Harness run context. |
| Workflow-owned retrieval | Explicit | Call `filterRetrievedChunks(...)` before putting application-owned chunks into an agent input. |
| Direct `ctx.models.*` calls or custom-handler agents | Not automatic | The caller owns that lifecycle. `attach(...)` rejects custom handlers rather than implying incomplete coverage. |

### Workflow with a guarded agent and retrieval

Keep business orchestration and retrieval in the workflow; delegate model and
tool work to an attached agent. This preserves typed Harness boundaries while
giving one trace tree for the workflow, rail checks, models, and tools.

```ts
const harness = defineHarness({ name: 'support' })
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .models({ assistant, safety })
  .tools({ transfer_money })
  .skills({ refund_policy: { directory: './skills/refund-policy' } })
  .agents(({ agent }) => ({
    support: rails.attach(agent({
      model: 'assistant',
      instructions: 'Help customers safely using approved policy.',
      tools: ['transfer_money'],
      skills: ['refund_policy'],
      builtinTools: ['read']
    }))
  }))
  .workflows(({ workflow }) => ({
    answer_customer: workflow({
      input: z.object({ question: z.string() }),
      output: z.string(),
      delegation: { agents: ['support'] },
      handler: async (ctx) => {
        const chunks = await searchApprovedKnowledge(ctx.input.question)
        const safeChunks = await rails.filterRetrievedChunks(chunks, {
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          models: ctx.models,
          signal: ctx.signal,
          logger: ctx.log
        })

        return ctx.agents.support({
          question: ctx.input.question,
          context: safeChunks
        })
      }
    })
  }))
  .build()
```

For a sensitive tool, use a tool-input rail and keep the existing Harness
permission or governance policy enabled. A transformed tool input is the value
that permission, governance, the Zod tool schema, and the tool handler see;
blocking stops execution before any side effect. Tool schemas must still be
strict because a rail can transform only to a valid JSON value, not grant a
tool broader authority.

```yaml
rails:
  tool_input:
    flows: [approve-transfer]
  tool_output:
    flows: [remove-sensitive-tool-result]
```

For example, `approve-transfer` can return
`{ decision: 'block', reasonCode: 'approval_required' }`. The trace then shows
the blocked `GUARDRAIL` span and no tool span or tool side effect. It does not
record the payment details.

## Operational use cases

- **Customer support:** redact identifiers on input and output; use retrieval
  rails to keep untrusted documents out of grounded answers.
- **Financial or health workflows:** block mutation tools until application
  approval policy permits the exact typed operation; preserve the decision and
  safety-model cost in the trace.
- **Document processing:** check retrieved chunks for prompt injection or data
  classifications before an agent sees them; retain the source system's own
  authorization and retention rules.
- **Skill-backed operators:** allowlist a mounted skill and the `read` tool;
  use tool rails to prevent access outside the intended skill paths and to
  sanitize any returned content before the model consumes it.

Use ordinary application authorization, Harness permissions, and governance
for authority decisions. Guardrails are a content and execution-control layer,
not an identity system or substitute for deterministic business rules.
