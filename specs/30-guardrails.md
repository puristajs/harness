# Typed NeMo-shaped guardrails

**Status:** approved implementation contract, 2026-08-23. The repository owner explicitly authorized this scope and automatic approval in the initiating task. This document is authoritative for the optional addon and its minimal core seam.

## Scope and ownership

`@purista/harness-guardrails` adapts the portable configuration vocabulary and input/output/retrieval/tool rail categories of [NVIDIA NeMo Guardrails](https://github.com/NVIDIA-NeMo/Guardrails). It does not copy or execute the Python runtime.

| Owner | Owns | Must not own |
| --- | --- | --- |
| `@purista/harness` | Generic ordered interception, normal model/tool lifecycle, schemas, state, cancellation, retry, governance, telemetry | NeMo YAML, safety policy values, providers, Python/Colang |
| `@purista/harness-guardrails` | YAML parsing, diagnostics, flow/action compilation, attach helper, explicit retrieval filter, content-free guardrail spans | Credentials, provider creation, server, vector store, second transcript/session, Core import |
| Application | Actions, safety thresholds, injected model aliases, retrieval, auth, secrets, end-user fallback text | Unreviewed executable config or implicit fail-open |
| `@purista/core` | Existing attached-agent/workflow pass-through | Addon dependency or duplicate lifecycle |

The addon is ESM-only and depends only on `@purista/harness`, `yaml`, and `zod`. No HTTP/CLI/UI/client surface, persistence record, durable data migration, or webhook is introduced; the addon only executes inside an existing Harness invocation.

## Capability matrix

| ID | Outcome | Entry and final state | Deterministic evidence |
| --- | --- | --- | --- |
| GR-01 | Load config | `loadGuardrailsConfig` returns typed config or non-retriable config error | parser fixtures |
| GR-02 | Attach rails | `rails.attach(definition)` returns a normal default-loop definition without a second session/provider | typecheck + fake provider |
| GR-03 | Input/output protection | transforms/blocks occur before the unsafe boundary | request/history assertions |
| GR-04 | Tool protection | input rail precedes permissions/governance/side effect; output rail precedes next model turn | side-effect counter |
| GR-05 | Retrieval protection | `filterRetrievedChunks` processes caller-owned chunks in order | retrieval fixture |
| GR-06 | Model check | `modelCheckRail` uses an injected Harness handle | fake provider |
| GR-07 | Safe operation | content-free GUARDRAIL spans and stable errors | telemetry/error tests |
| GR-08 | Migration safety | unsupported executable NeMo features reject, never approximate | rejection fixtures |

## Core interception contract

`AgentDefinition.interceptors` is ordered and applies only to the default loop. A custom `handler` owns its provider/tool lifecycle and receives no interceptor hooks.

| Phase | Position | Transform | Block/failure final state |
| --- | --- | --- | --- |
| `beforeInput` | after input schema parse; before dynamic instructions, transcript, model | typed agent input | no model call/transcript write |
| `beforeModel` | after `prepareStep` and governance tool exposure; before provider | complete request | no provider call |
| `afterModel` | after provider; before model event/output validation/tool dispatch/persistence | complete response | no output/event/transcript write |
| `beforeTool` | before permissions, governance, `tool.started`, side effect | JSON-compatible tool input | no side effect |
| `afterTool` | after validated output; before `tool.finished`/model continuation | JSON-compatible output | no continuation |

Each hook returns `allow`, `block`, or `transform`. A block, malformed result, or hook exception terminates with non-retriable `AgentInterceptorError`; it is never converted to a model-visible tool error. Existing cancellation, timeout, retry, idempotency, state, logging, telemetry, and governance remain the sole Harness implementation.

## Portable config and migration boundary

```yaml
models:
  - type: main
    engine: harness
    model: assistant
instructions: []
prompts: {}
custom_data: {}
rails:
  input: { flows: [flow-id] }
  output: { flows: [flow-id] }
  tool_input: { flows: [flow-id] }
  tool_output: { flows: [flow-id] }
  retrieval: { flows: [flow-id] }
```

`models` is descriptive; `modelAliases` maps its `type` to an already configured Harness alias. YAML never instantiates a provider, reads a key, or selects a network destination. Each configured flow must resolve to an application-owned action.

| Source feature | Required behavior |
| --- | --- |
| `config.yml`/`config.yaml` | exactly one file per directory; strict shape diagnostics |
| `input`, `output`, `tool_input`, `tool_output`, `retrieval` | compile to matching phase |
| `models`, `instructions`, `prompts`, `custom_data` | preserve metadata only |
| `.co`, `actions.py`, `config.py` | reject `unsupported_executable_config` |
| `rails.dialog`, `rails.execution` | reject `unsupported_rail_category` |
| unknown rail/category/shape | reject with field/path diagnostic |
| LangChain, server, action server, vector store | unsupported; never infer |

Colang 1/2 parity is outside this release. It needs a separately approved grammar, durable dialogue-state, compatibility, security, and migration specification.

## Action, failure, privacy, and telemetry contract

An action returns exactly `{decision:'allow'}`, `{decision:'block'}`, or `{decision:'transform', target, value}`. Allowed transform targets are closed by phase: `user_message`, `bot_message`, `tool_input`, `tool_output`, and `relevant_chunks`. Mismatch, malformed outcome, non-array retrieval transform, or action exception fails closed. Flows execute sequentially in YAML order; no parallel flag exists because transforms have observable ordering.

`modelCheckRail({model,instructions})` accepts only `{allow:boolean}`, resolves through `modelAliases`, and invokes an existing Harness handle. It has no provider SDK dependency.

- Production default is `contentCaptureMode: 'NO_CONTENT'`.
- Addon spans are `evaluate_guardrail {rail.id}` with `openinference.span.kind=GUARDRAIL`, `harness.guardrail.id`, and `harness.guardrail.phase` only.
- Error metadata is bounded to ids, phases, and reason codes. Prompts, completions, documents, tool inputs/results, provider bodies, and credentials are forbidden from spans, logs, errors, events, and fixtures.
- Application action reasons are content-free operator diagnostics, never end-user responses.

## File, build, and acceptance contract

| Path | Owner |
| --- | --- |
| `packages/harness/src/harness/defineHarness.ts` | public generic hook types |
| `packages/harness/src/agents/index.ts` | precise hook order and terminal enforcement |
| `packages/harness-guardrails/src/` | config/errors/compiler/public API |
| `packages/harness-guardrails/test/` | deterministic `FakeModelProvider` coverage |
| `examples/guardrails/` | runnable no-network example |
| `docs/guides/guardrails.md`, `skills/ai-harness/` | public user guidance |

Root workspace `lint`, `build`, `test`, `test:coverage`, and `ci` discover every package/example workspace; CI already runs these root scripts and package dry-run verification. Release requires core interceptor tests, addon parser/input/output/tool/retrieval tests, example test, typecheck, package build, and content-free telemetry assertions.

## No-invention gate

Stop and write a new approved spec before adding Colang, Python action loading, provider construction, secrets, server/network behavior, vector storage, parallel transform execution, persistent guardrail state, custom-handler interception, extra telemetry content, or a Core dependency.
