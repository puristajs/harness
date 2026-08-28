# Typed NeMo-shaped guardrails

> **Approved authoring update (2026-08-26):** [38-guardrail-authoring](./38-guardrail-authoring/00-vision.md) supersedes this document for configuration, file loading, action authoring and binding. Other runtime semantics remain in force. Target approved; implementation is planned separately.

**Status:** approved implementation contract, 2026-08-23. The repository owner explicitly authorized this scope and automatic approval in the initiating task. This document retains portable configuration scope; the approved 2026-08-26 decision-boundary spec supersedes action, phase and lifecycle contracts.

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
| GR-08 | Unsupported-feature rejection | unsupported executable NeMo features reject, never approximate | rejection fixtures |

## Core interception contract

The [approved decision-boundary contracts](./37-decision-boundaries/03-contracts/decisions.md) own exact phase types, beforeOutput finalization, safe shared errors/evidence, runtime JSON checks and the shared bounded callback executor. Addon output rails bind to beforeOutput. afterModel is allow/block only; beforeModel transforms messages only while preserving protected tool interactions. Default-loop interception does not wrap custom handlers or direct ctx.models calls.

## Portable configuration boundary

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

The parser is strict at every accepted mapping. It accepts only root
`models`, `instructions`, `prompts`, `custom_data`, and `rails`; model
`type`, `engine`, `model`, and `parameters`; phase `flows`; and the
`rails.config.sensitive_data_detection` subtree defined in
`31-sensitive-data-guardrails.md`. `models`, `instructions`, `prompts`, and
`custom_data` are preserved descriptive metadata only: they do not select a
provider, inject an agent prompt, render a template, or execute behavior.

Public Guardrails documentation includes an architecture diagram and a phase
coverage table. They show the exact default-loop order: parsed agent input,
ordered input rails, application-owned retrieval plus an explicit retrieval
filter, model call, the repeated tool-input/validation/permission-governance/
side-effect/tool-output loop, ordered output rails, and output validation or
delivery. The documentation explicitly marks that each phase runs sequentially
(not in parallel), that blocked/failed actions end the protected path
fail-closed, and that direct model calls, custom-handler agents, unfiltered
retrieval, and uninspected structured fields are outside automatic coverage.

When a directory is loaded, the directory tree is also an explicit configuration
boundary: the single root `config.yml`/`config.yaml` is the only consumed
configuration source. Nested or root `.co`/`.py` files, `prompts.yml` or
`prompts.yaml`, and NeMo `actions` or `kb` directories reject with a stable
unsupported-config diagnostic instead of being ignored. Applications keep
their own assets outside the guardrails configuration directory.

| Source feature | Required behavior |
| --- | --- |
| `config.yml`/`config.yaml` | exactly one file per directory; strict shape diagnostics |
| `input`, `output`, `tool_input`, `tool_output`, `retrieval` | compile to matching phase |
| `models`, `instructions`, `prompts`, `custom_data` | preserve metadata only |
| `.co`, `actions.py`, `config.py` | reject `unsupported_executable_config` |
| `rails.dialog`, `rails.execution` | reject `unsupported_rail_category` |
| unknown rail/category/shape | reject with field/path diagnostic |
| LangChain, server, action server, vector store | unsupported; never infer |

Colang 1/2 parity is outside this release. It needs a separately approved grammar, durable dialogue-state, security and execution specification.

## Action, failure, privacy, and telemetry contract

Exact action outcome/phase generics, schema binding, reasonCode grammar, shared evidence and error types, timeout ownership and fail-closed behavior are defined once in [decision contracts](./37-decision-boundaries/03-contracts/decisions.md). Keep GUARDRAIL spans and existing sensitive-data nested spans; operational projections never contain inspected values. Retrieval uses the same evidence/error helpers via public core exports and one occurrence ID per evaluation. No addon-local timer, error projection or evidence identity implementation remains.

## File, build, and acceptance contract

| Path | Owner |
| --- | --- |
| `packages/harness/src/harness/defineHarness.ts` | public generic hook types |
| `packages/harness/src/agents/index.ts` | precise hook order and terminal enforcement |
| `packages/harness-guardrails/src/` | config/errors/compiler/public API |
| `packages/harness-guardrails/test/` | deterministic `FakeModelProvider` coverage |
| `examples/guardrails/` | runnable no-network example |
| `docs/guides/guardrails.md`, `skills/ai-harness/` | public user guidance |

Root workspace `lint`, `build`, `test`, `test:coverage`, and `ci` discover every package/example workspace; CI already runs these root scripts and package dry-run verification. Release requires core interceptor tests, addon parser/input/output/tool/retrieval tests, deterministic recording-telemetry assertions for allow/block/transform/error/privacy/metric/span status, retrieval model context, and nested model alias/provider/token usage trace attribution, example test, typecheck, package build, and content-free telemetry assertions.

## No-invention gate

Stop and write a new approved spec before adding Colang, Python action loading, provider construction, secrets, server/network behavior, vector storage, parallel transform execution, persistent guardrail state, custom-handler interception, extra telemetry content, or a Core dependency. The sole approved exception is the provider-neutral sensitive-data port and its optional Presidio/native adapters specified in [31-sensitive-data-guardrails.md](./31-sensitive-data-guardrails.md).
