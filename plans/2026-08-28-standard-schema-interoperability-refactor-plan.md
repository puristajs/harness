# Standard Schema interoperability: feasibility research (superseded plan)

> Superseded on 2026-08-28 by the approved content-bound specification at `specs/39-standard-schema-boundaries` and executable plan at `plans/standard-schema-boundaries`. Retain this file only as the original investigation record; agents must not execute it.

Status: proposed, decision-complete research plan; implementation is blocked on
the specification and readiness gates in Phase 0.

Prepared: 2026-08-28  
Research baselines: `ai-harness@74838ca`, `purista@a5e4cbc0c`  
Affected repositories: `ai-harness` (runtime and package documentation),
`purista` (framework integration, canonical skill mirrors, public Handbook, and
generated Harness API documentation), plus shared handbook specifications under
the workspace `specs/50-handbook` only if the approved information architecture
must change.

## Executive decision

Harness can support user-selected validation libraries without changing its
model-provider adapter abstraction. The recommended design is additive:

1. Keep Zod as Harness's internal schema library, installed dependency, default
   authoring recommendation, and source of internal configuration/persistence
   schemas.
2. Replace Zod-specific **public user-authored validation boundaries** with the
   validation trait `StandardSchemaV1`.
3. Require the additional, orthogonal `StandardJSONSchemaV1` trait only for a
   schema that Harness sends to a model: TypeScript tool input and default-loop
   agent structured output.
4. Convert those model-facing schemas to JSON Schema once during Harness build
   and cache the result. Provider adapters continue to receive only `JsonValue`
   JSON Schema through the existing `ModelToolSpec.parameters` and
   `ObjectRequest.schema` ports.
5. Continue to validate every external/model/handler value locally with the
   original Standard Schema. Provider structured-output enforcement is an
   optimization and generation constraint, not Harness's validation authority.

This is sufficient for the Harness use case with one explicit qualification:
"supports Standard Schema" must not be documented as "every Standard Schema
validator can be used for every Harness boundary." A validation-only schema is
sufficient for workflows, custom-handler agents, tool output, and guardrail
values. A model-facing schema must also expose a sound JSON Schema projection.
Even then, each model provider supports only a subset of JSON Schema. Harness
must surface conversion and provider-rejection failures precisely and must not
promise cross-provider semantic equivalence for constraints that JSON Schema or
the selected provider cannot express.

The provider-SDK concern is therefore manageable. OpenAI's JavaScript SDK offers
Zod helpers, but its wire API accepts JSON Schema. The current Harness OpenAI,
Anthropic, Bedrock, and Azure Foundry adapters already pass plain JSON Schema and
do not depend on Zod. No provider-specific validator bridge is needed.

## Why this conclusion is credible

### Current Harness execution trace

| Boundary | Current user contract | Runtime behavior | Model-facing JSON Schema? | Required target contract |
| --- | --- | --- | --- | --- |
| Agent input | `z.ZodTypeAny` | `.parse(...)` before instructions/handler | No | `HarnessSchema` |
| Default-loop agent output | `z.ZodTypeAny` | `z.toJSONSchema(..., { io: 'input' })`, then `.parse(...)` | Yes | `HarnessModelSchema` |
| Custom-handler agent output | `z.ZodTypeAny` | `.parse(...)` after handler | No | `HarnessSchema` |
| Workflow input/output | `z.ZodTypeAny` | `.parse(...)` around handler | No | `HarnessSchema` |
| TypeScript tool input | `z.ZodTypeAny` | `z.toJSONSchema(..., { io: 'input' })`, then `.parse(...)` before handler | Yes | `HarnessModelSchema` |
| TypeScript tool output | `z.ZodTypeAny` | `.parse(...)` after handler | No | `HarnessSchema` |
| Guardrail `valueSchema` | `z.ZodTypeAny` | `.safeParse(...)` before action and after transform | No | `HarnessSchema` |
| Direct `ctx.models.<alias>.object` | `JsonValue` JSON Schema | passed to provider port | Already JSON Schema | unchanged |
| Internal config/state/errors/built-ins | Zod | internal parsing and inferred types | sometimes internally converted | unchanged Zod |

Primary implementation evidence:

- `packages/harness/src/harness/defineHarness.ts` binds all agent, workflow,
  and TypeScript-tool generics to Zod.
- `packages/harness/src/agents/index.ts`,
  `packages/harness/src/agents/tool-execution.ts`, and
  `packages/harness/src/workflows/index.ts` call Zod methods directly and catch
  `ZodError`.
- `packages/harness-guardrails/src/action.ts` and `rails.ts` bind public
  guardrail value schemas to Zod and assume synchronous `safeParse`.
- `packages/harness/src/ports/model-provider.ts` defines
  `ModelToolSpec.parameters` and `ObjectRequest.schema` as `JsonValue`.
- `packages/harness-openai`, `packages/harness-anthropic`,
  `packages/harness-bedrock`, and `packages/harness-azure-foundry` place those
  JSON values directly into provider request schema fields.

### Standards and provider evidence

- [Standard Schema](https://github.com/standard-schema/standard-schema) defines
  validation and input/output inference. Its validator may be synchronous or
  asynchronous.
- [Standard JSON Schema](https://standardschema.dev/json-schema) is deliberately
  separate from validation, has distinct input/output projections, may throw
  when conversion is unsound, and explicitly names AI tool inputs and structured
  outputs as use cases.
- Current compatible Standard JSON Schema examples include Zod 4.2+, ArkType,
  and Valibot through `@valibot/to-json-schema`. Harness's installed Zod 4.4.3
  exposes both the validation and JSON Schema traits locally.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
  accept JSON Schema at the API boundary and support only a subset; the Zod
  helper is SDK convenience.
- [Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
  accepts `input_schema` JSON Schema and documents a supported subset.
- [Amazon Bedrock structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
  validate a Draft 2020-12 subset and reject unsupported schemas.
- [Azure OpenAI structured outputs](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs)
  likewise use JSON Schema at the service boundary.

### Existing PURISTA proof

`purista/packages/core/src/schema/standardSchema.ts` already proves the core
pattern: Standard Schema type inference, asynchronous validation, input/output
JSON Schema direction, and trait detection. Harness must not import PURISTA core,
but it should mirror the standard contracts and error discipline rather than
invent a second interoperability model. Harness does **not** inherit PURISTA's
Yup-specific converter fallback; libraries without the standard JSON trait must
use their own standard wrapper at model-facing boundaries.

### Defect discovered during the trace

`packages/harness/src/sessions/index.ts` currently casts the memory-summary
model handle so `schema` is a Zod type and passes `z.object(...)` directly.
The actual model port and all four adapters require JSON Schema. The refactor
must add a regression test and send a compiled `JsonValue` schema. This fix is
required even if broader Standard Schema support is later declined.

## Immutable design decisions for the proposed specification

Phase 0 must copy these decisions into the approved spec. Implementation agents
must not rename or reinterpret them.

| ID | Decision |
| --- | --- |
| SSI-01 | Zod remains a runtime dependency of `@purista/harness` and `@purista/harness-guardrails` for internal schemas and remains the recommended/default documentation path. This work is not a Zod purge. |
| SSI-02 | Add `@standard-schema/spec@^1.1.0` as a direct dependency of `@purista/harness`, aligned with PURISTA core; public schema types are imported from that package and re-exported only through Harness-owned semantic aliases. Do not copy the standard interfaces into source. |
| SSI-03 | Export `HarnessSchema<Input extends JsonValue = JsonValue, Output extends JsonValue = Input>` for validation-only boundaries. It is structurally compatible with `StandardSchemaV1<Input, Output>`. |
| SSI-04 | Export `HarnessModelSchema<Input extends JsonValue = JsonValue, Output extends JsonValue = Input>` whose `~standard` props combine `StandardSchemaV1.Props` and `StandardJSONSchemaV1.Props`. It is required only where Harness must both validate and project JSON Schema. |
| SSI-05 | Export `InferSchemaInput<S>` and `InferSchemaOutput<S>` as Harness-named aliases over the standard inference types. Do not expose Zod-specific inference in public Harness declarations. |
| SSI-06 | All public agent, workflow, tool, and guardrail schema input/output types remain JSON-compatible. A transform whose successful output is `Date`, `Map`, class instance, function, symbol, bigint, or another non-`JsonValue` is rejected by type tests where inferable and at runtime before persistence/model/tool propagation. |
| SSI-07 | Standard Schema validation is always awaited. Any result with a defined `issues` property becomes `ValidationError`, including a non-conforming empty issue array. A validator that throws/rejects outside the standard result contract becomes `InternalError` with exactly `{ reason: 'schema_validation_execution_failed', where: <existing ValidationError where> }` and an internal cause; raw input is never metadata. |
| SSI-08 | Normalize serialized validation issues to exactly `{ count: number, truncated: boolean }`, where `count` is capped at 100 and `truncated` reports whether more than 100 issues were returned. Standard Schema does not guarantee that vendor messages or path keys exclude rejected/user-controlled values, so neither is serialized. Preserve the returned issue array only on a private, non-exported `StandardSchemaValidationCause extends Error` assigned as `ValidationError.cause`; Harness serialization must ignore it. Never serialize validator instances, raw values, vendor issue messages/paths, or arbitrary thrown objects into error metadata. |
| SSI-09 | Compile model-facing schemas with `~standard.jsonSchema.input({ target: 'draft-2020-12' })`. Tool input and default-loop agent output both describe the value the model must produce before local transforms, so both use the input projection. |
| SSI-10 | Compile and deep-freeze default model-facing JSON Schemas once during synchronous `.build()`. Cache by registered boundary, not vendor or object identity. Conversion is not repeated per session, run, tool exposure pass, or agent loop step. |
| SSI-11 | Missing JSON projection, thrown conversion, non-object conversion result, or non-`JsonValue` conversion result fails `.build()` with `HarnessConfigError`. Stable reasons are `schema_json_projection_missing`, `schema_json_projection_failed`, and `schema_json_projection_invalid`. Extend its typed metadata with only `schema_boundary?: 'agent_output' | 'tool_input'`, existing `id?: string`, `schema_vendor?: string`, and `schema_target?: 'draft-2020-12'`; vendor is included only when it is a bounded non-empty string. |
| SSI-12 | Validation-only schemas are permitted for workflow input/output, custom-handler agent input/output, TypeScript-tool output, and guardrail values. TypeScript-tool input and default-loop agent output require `HarnessModelSchema`. |
| SSI-13 | Agent definitions become a correlated union: the default-loop variant (no `handler`) requires model-projectable output; the custom-handler variant requires only validation. Existing omission defaults remain internal `z.string()` schemas implementing both traits. |
| SSI-14 | `ctx.models.<alias>.object` continues to accept explicit `JsonValue` JSON Schema. It does not accept a validator and does not promise local validation. Callers that need validation use their schema before/after the direct model call. |
| SSI-15 | Provider adapter packages remain validator-library neutral and gain no Zod, ArkType, Valibot, or Standard Schema dependency. Adapter contract tests prove exact JSON Schema pass-through. |
| SSI-16 | Harness local validation is authoritative. Provider-native strict schema enforcement may be used only in a separate provider-capability workstream because current adapters and providers differ. This refactor does not set new `strict` flags or rewrite schemas into provider-specific subsets. |
| SSI-17 | Do not silently delete, weaken, or rewrite unsupported JSON Schema keywords. A provider rejection remains a normalized `ModelError`; documentation identifies the provider subset and recommends a simpler model-facing schema plus richer local validation when necessary. |
| SSI-18 | Zod users require no code migration when using the currently supported Zod 4.4 line. Existing examples stay Zod-first. Add one ArkType example and one Valibot wrapper example on the canonical structured-input/output page; do not duplicate alternatives across every guide. |
| SSI-19 | Plain JSON Schema, Ajv validators without Standard Schema traits, Yup-specific dynamic conversion, and library registries/adapters inside Harness are out of scope. Users may wrap a library externally if the wrapper implements the required standard trait(s). |
| SSI-20 | This is eligible for a backward-compatible minor release only if all existing Zod type fixtures and runtime tests pass unchanged. Any unavoidable source incompatibility changes the release classification to major and blocks release until a migration section and owner approval exist. |

## Public contract proposed for the spec

The approved spec must provide declarations equivalent to the following. Exact
TSDoc may improve, but names and semantics are locked by `SSI-01` through
`SSI-20`.

```ts
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

export type HarnessSchema<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = Input,
> = StandardSchemaV1<Input, Output>

export interface HarnessModelSchemaProps<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = Input,
> extends StandardSchemaV1.Props<Input, Output>,
    StandardJSONSchemaV1.Props<Input, Output> {}

export interface HarnessModelSchema<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = Input,
> {
  readonly '~standard': HarnessModelSchemaProps<Input, Output>
}

export type InferSchemaInput<S extends HarnessSchema> =
  StandardSchemaV1.InferInput<S>

export type InferSchemaOutput<S extends HarnessSchema> =
  StandardSchemaV1.InferOutput<S>
```

The spec author must compile this exact shape against the installed Zod 4.4.3,
`arktype@^2.1.28`, and `valibot@^1.2.0` wrapped by
`@valibot/to-json-schema@^1.5.0` before approval. These are development/test
dependencies only; the lockfile records the exact resolved test versions.
The research pass compiled the declaration above with the repository's strict
TypeScript toolchain against installed Zod 4.4.3, including an object schema and
a JSON-compatible transform. ArkType and Valibot remain mandatory Phase 0
compile proofs because they are not installed in the current Harness workspace.
If TypeScript variance prevents the `JsonValue` bounds from accepting ordinary
object schemas, Phase 0 may adjust only the generic constraint mechanics, not
the JSON-only invariant or public names. That adjustment must be recorded as an
approved spec amendment with positive and negative type fixtures; an
implementation ticket must not decide it ad hoc.

## Scope

### Included

- Public agent, workflow, TypeScript-tool, and Guardrails value schema types.
- Central asynchronous validation and bounded issue normalization.
- Central Standard JSON Schema detection, input projection, build-time failure,
  caching, and freezing.
- Agent/tool/workflow/session/guardrail runtime adoption.
- The memory-summary schema defect.
- Public exports, TSDoc, type tests, runtime tests, contract tests, examples,
  package docs, release notes, canonical AI Harness skill, PURISTA integration
  verification, public Handbook, generated API docs, and drift audits.
- Compatibility fixtures for Zod, ArkType, and Valibot's official wrapper.

### Excluded

- Replacing internal Zod schemas.
- Provider-specific schema lowering, keyword stripping, or strict-mode rollout.
- A new model-provider port or changes to `ObjectRequest.schema` and
  `ModelToolSpec.parameters`.
- Accepting plain JSON Schema as an agent/workflow/tool validator.
- Shipping converters for individual validation libraries.
- Claiming compatibility with every Standard Schema implementation or every
  schema feature of a named library.
- Changing PURISTA core's established Standard Schema implementation.
- Reorganizing unrelated handbook routes or resolving existing unrelated dirty
  worktree changes.

## Gate model

No autonomous implementation ticket may start from this proposed plan alone.
The existing root readiness report and spec-38 approval do not approve this new
public contract.

| Gate | Pass condition | Blocks |
| --- | --- | --- |
| `GATE-SSI-BASELINE` | Owner confirms the captured baselines and unrelated dirty files; spec-38 implementation/status is reconciled against current source. | All spec edits |
| `GATE-SSI-SPEC` | New `specs/39-standard-schema-boundaries/` manifest is complete, named decisions above are normative, affected base specs are updated/superseded, and a readiness review reports `approved` with a recorded manifest digest. | Ticket generation and source edits |
| `GATE-SSI-CONTRACT` | Schema substrate, public declarations, Zod/ArkType/Valibot type/runtime fixtures, async validation, issue normalization, JSON projection, and build-time caching pass. | Runtime migration |
| `GATE-SSI-RUNTIME` | Agents, workflows, tools, sessions, and Guardrails pass focused plus full Harness gates with no Zod regression. | Docs/release claims |
| `GATE-SSI-PROVIDERS` | All four first-party adapter contract suites prove the same JSON Schema value reaches the provider request and provider packages have no validator dependency. | Provider-neutral compatibility claim |
| `GATE-SSI-DOCS` | Package docs, skill, public Handbook, API generation, examples, links, and migration/release text pass repository audits and rendered review. | Release |
| `GATE-SSI-RELEASE` | Packed-package consumer tests pass on the supported Node/Bun/TypeScript matrix; release classification is confirmed minor or escalated to major. | Publication |

## Phase 0 — specification, readiness, and ticket generation

This is the only phase authorized by this research plan before owner approval.

### SSI-P0-01 — reconcile the implementation baseline

- Repository: `ai-harness`.
- Read scope: `specs/38-guardrail-authoring/**`, its plan/status files, the
  current Guardrails implementation/tests, current dirty files, and git history
  since both research baselines.
- Write scope: new analysis/evidence files inside
  `specs/39-standard-schema-boundaries/` only. Do not modify existing dirty
  files during reconciliation.
- Deliverable: an evidence ledger separating current implementation, approved
  prior intent, stale status, and new work. Record the memory-summary mismatch
  as an existing defect.
- Acceptance: every affected public boundary has a source path, current test
  owner, governing spec clause, and proposed supersession clause; no status is
  inferred from a historical plan.

### SSI-P0-02 — author the canonical specification

- Repository: `ai-harness`.
- Write scope: `specs/39-standard-schema-boundaries/**`, plus only the exact
  clauses in `specs/00-overview.md`, `01-architecture.md`, `02-harness-config.md`,
  `06-models.md`, `07-tools.md`, `09-agents.md`, `10-workflows.md`,
  `13-public-api.md`, `15-error-catalog.md`, `16-testing.md`, and
  `38-guardrail-authoring/**` identified by the ledger. Use the actual current
  filename if a listed conceptual spec has a different repository name.
- Deliverable: manifest-bound specification covering types, runtime behavior,
  conversion/caching, error metadata, compatibility, security/privacy,
  provider boundary, test matrix, delivery, documentation, and rollback.
- Required normative content: `SSI-01` through `SSI-20`, the public declaration
  compile proof, exact boundary matrix, exact stable error reasons, exact
  JSON-Schema direction/target, and the non-goals.
- Acceptance: all old statements that say public boundaries require Zod are
  explicitly superseded; internal Zod ownership remains explicit; no base spec
  simultaneously owns a conflicting type or error contract.

### SSI-P0-03 — readiness review and owner approval

- Run the repository's deterministic spec checks and readiness workflow against
  the new manifest.
- A readiness report must be `approved`, refer to the current manifest digest,
  contain no unresolved owner decision, and show traceability from every
  acceptance criterion to source/tests/docs.
- The owner approves or rejects the spec. Approval is recorded in the spec,
  not inferred from this plan.
- If the public type compile proof requires a change to the proposed generic
  mechanics, return to `SSI-P0-02`; do not waive the check.

### SSI-P0-04 — generate implementation tickets

After `GATE-SSI-SPEC`, use the spec implementation planner to generate
manifest-bound tickets from the provisional slices below. Each ticket must have
one write owner, exact read/write scopes, dependency IDs, acceptance IDs,
verification commands, evidence output, and D0/D1 autonomy only. Shared public
exports, manifests/lockfile, public docs/navigation, and final integration each
have one integrator owner.

## Provisional implementation slices after spec approval

These are a ticket-generation blueprint, not executable tickets before
`GATE-SSI-SPEC`.

### Wave 1 — schema substrate and public type contract

#### SSI-001 — add the Standard Schema substrate

- Repository: `ai-harness`.
- Write owner: `packages/harness/package.json`, root lockfile,
  `packages/harness/src/schema/**`, and focused `packages/harness/test/schema*`.
- Deliverable:
  - direct `@standard-schema/spec` dependency;
  - public semantic types from the approved declaration;
  - `validateHarnessSchema` that awaits sync/async validators;
  - content-free issue summary from `SSI-08`;
  - `compileHarnessModelSchema` using Draft 2020-12 input direction;
  - `JsonValue`/plain-object checks and deep freezing;
  - exact config/internal error classification.
- Tests:
  - successful synchronous transform;
  - successful asynchronous transform;
  - returned issues, including paths and vendor messages containing sentinel
    content, reduced to the bounded count/truncation summary;
  - thrown/rejected validator;
  - missing JSON trait;
  - converter throw;
  - invalid/non-JSON converter result;
  - input projection selected and output projection not called;
  - no raw input, vendor issue message, or library issue object in serialized
    errors; direct errors may retain original issues only in the non-serialized
    cause.
- Forbidden: provider imports, Zod vendor branches, converter registry, Yup
  fallback, keyword rewriting, or direct PURISTA-core dependency.

#### SSI-002 — generalize builder definitions and inference

- Repository: `ai-harness`.
- Write owner: schema-related declarations/helpers in
  `packages/harness/src/harness/defineHarness.ts`, main exports,
  `test/public-api.test.ts`, and `packages/harness/type-tests/**`.
- Deliverable: replace public `z.ZodTypeAny`, `z.input`, and `z.output` bindings
  with approved Harness schema types/inference; add correlated default/custom
  agent variants; retain builder-local brands and contextual inference.
- Positive type fixtures: unchanged current Zod examples; Zod transform within
  JSON; ArkType agent/workflow/tool; Valibot wrapped model schema; omitted
  string schemas; handler input receives inferred schema output and handler
  return accepts schema input.
- Negative type fixtures: validation-only schema as tool input/default-loop
  output; non-JSON transform; handler returns validated output instead of
  accepted output where input/output differ; unbranded tool; plain JSON Schema;
  object with only a look-alike `parse` method.
- Acceptance: current Zod type fixtures compile without edits except imports
  that expose previously accidental internal types; main export snapshot and
  generated declaration surface match the approved spec.

#### SSI-003 — precompile and cache registered model schemas

- Repository: `ai-harness`.
- Write owner: build/config assembly paths in
  `packages/harness/src/harness/defineHarness.ts`, private compiled-definition
  types, and focused build tests.
- Deliverable: `.build()` compiles every TypeScript-tool input and default-loop
  agent output exactly once, records the frozen JSON Schema on private runtime
  definitions, and fails before session/model/provider side effects.
- Acceptance:
  - converter call count is one per registered boundary;
  - two tools sharing one schema object still have independently attributable
    boundary failures;
  - custom-handler agent output and workflow schemas never request JSON
    projection;
  - failure metadata names only the registered agent/tool and boundary;
  - no converter function/schema instance becomes public inspection or
    persistence data.

`GATE-SSI-CONTRACT` runs after SSI-001 through SSI-003 and an independent code
review against the approved spec.

### Wave 2 — core runtime adoption

#### SSI-004 — migrate agent and session validation

- Write owner: `packages/harness/src/agents/**`, the schema-specific sections of
  `packages/harness/src/sessions/index.ts`, and focused agent/session tests.
- Deliverable:
  - await central validation for agent input/final output and committed-output
    replay;
  - use precompiled default-loop output JSON Schema on every model step;
  - remove Zod-specific catches/conversion from those paths;
  - fix conversation-summary model requests to send a frozen `JsonValue` JSON
    Schema and locally validate the returned object with its internal Zod
    schema.
- Acceptance:
  - sync/async vendor schemas and transforms work;
  - invalid model output never commits a final message;
  - committed replay validates asynchronously and returns `undefined` on normal
    validation issues without swallowing validator execution faults;
  - loop iterations reuse the same schema object/value and never reconvert;
  - memory-summary adapter tests assert a plain JSON Schema request, not a Zod
    instance.

#### SSI-005 — migrate TypeScript tool execution

- Write owner: TypeScript-tool branches in
  `packages/harness/src/agents/tool-execution.ts`, custom-tool spec assembly in
  `packages/harness/src/agents/index.ts`, and focused tool tests.
- Deliverable: expose cached input JSON Schema; await input/output validation;
  preserve transformed input/output inference and JSON fence; use normalized
  issues in preflight and execution failures.
- Acceptance:
  - invalid tool input fails before permissions/governance/handler side effects
    at the same lifecycle point specified by current ordering contracts;
  - async input validation completes before binding preparation;
  - async output validation completes before tool-result emission;
  - batch cancellation and recoverable tool-error semantics remain unchanged;
  - no Zod detection remains in the TypeScript-tool branch; built-in Zod
    schemas may remain internal.

#### SSI-006 — migrate workflow validation

- Write owner: `packages/harness/src/workflows/index.ts` and focused
  workflow/durable-workflow tests.
- Deliverable: await central input/output validation, preserve abort ordering
  and handler error identity, and remove library-specific issue handling.
- Acceptance: async schemas work in normal and durable execution; invalid
  output is not checkpointed as success; replay behavior and cancellation remain
  spec-conformant; validation-only schemas never request JSON projection.

### Wave 3 — Guardrails public authoring boundary

#### SSI-007 — generalize Guardrails value schemas

- Repository: `ai-harness`.
- Write owner: public value-schema types and runtime validation in
  `packages/harness-guardrails/src/action.ts`, `rails.ts`,
  `sensitive-data.ts`, public exports/type tests, and focused tests. Internal
  Guardrails config/decision/model-check Zod schemas remain untouched.
- Deliverable: use `HarnessSchema` and standard inference for action values and
  typed codecs; make preparation and transform-result validation asynchronous
  without changing rail order, timeout ownership, fail-closed behavior, or
  content-safe observability.
- Acceptance:
  - Zod authoring still compiles unchanged;
  - ArkType and Valibot validation-only value schemas compile and run;
  - async validation is inside the existing action deadline/cancellation
    boundary;
  - invalid transformed values fail before continuation/tool side effects;
  - errors contain normalized issues and no guarded content;
  - model-backed internal checks still send explicit JSON Schema and use
    internal Zod validation.

### Wave 4 — provider and integration proof

#### SSI-008 — prove provider JSON Schema neutrality

- Repository: `ai-harness`.
- Write owner: contract fixtures and focused tests in each of
  `packages/harness-openai`, `harness-anthropic`, `harness-bedrock`, and
  `harness-azure-foundry`; no production adapter change unless a pass-through
  test exposes a defect.
- Deliverable: a shared fixture JSON Schema containing nested object, enum,
  array, required fields, and `additionalProperties: false`, asserted at each
  SDK request boundary for tool input and structured object output.
- Acceptance:
  - exact structural schema is preserved; adapters do not receive a validator;
  - package manifests contain no validator/Standard Schema dependency;
  - unsupported provider schema tests assert normalized provider failure rather
    than Harness keyword deletion;
  - no live credentials/network are required.

#### SSI-009 — verify PURISTA attached-agent compatibility

- Repository: `purista`.
- Write owner: only focused attached-agent type/runtime tests and TSDoc affected
  by the published Harness public types. No change to
  `packages/core/src/schema/standardSchema.ts` unless a failing integration test
  proves an actual framework defect and the approved spec is amended.
- Deliverable: Zod attached-agent definitions remain source-compatible; one
  non-Zod Standard Schema fixture proves the Harness definition can pass through
  PURISTA's builder/runtime wrapper without type erasure or double conversion.
- Acceptance: command payload/output validation remains PURISTA-owned; Harness
  agent validation remains Harness-owned; no framework package imports ArkType
  or Valibot in runtime dependencies.

`GATE-SSI-RUNTIME` and `GATE-SSI-PROVIDERS` run after SSI-004 through SSI-009.

### Wave 5 — package docs, examples, skills, and public website

#### SSI-010 — update package-local docs and maintained examples

- Repository: `ai-harness`.
- Canonical ownership:
  - Zod-first quickstart remains the default.
  - `docs/guides/usage.md` and `docs/guides/tools-and-skills.md` explain the
    validation-only versus model-facing distinction and link to the canonical
    public Handbook page.
  - `docs/reference/public-api.md` owns exact Harness schema aliases and failure
    reasons.
  - `docs/operations/runbook.md` owns conversion/provider-rejection diagnosis.
  - `docs/reference/spec-conformance.md` records Standard Schema conformance.
  - a new release note owns compatibility and semver classification.
- Update every Zod-exclusive claim found in `docs/guides/guardrails.md`,
  `tools-and-skills.md`, `usage.md`, `workflows.md`, `operations/runbook.md`,
  `reference/public-api.md`, and `reference/spec-conformance.md`. Preserve the
  historical meaning of existing release notes; add a superseding note rather
  than rewriting history.
- Add maintained compile/run examples for:
  1. Zod default path;
  2. ArkType model-facing agent/tool schema;
  3. Valibot validation plus `toStandardJsonSchema(...)` at a model-facing
     boundary;
  4. a validation-only async fake in tests, not recommended application code.
- Do not install ArkType/Valibot in production packages. They are example/test
  development dependencies only.

#### SSI-011 — update and synchronize the canonical AI Harness skill

- Repository: `ai-harness`, followed by the configured runtime mirror.
- Write owner: `skills/ai-harness/SKILL.md` and only the relevant references:
  `agents-workflows-tools.md`, `configuration.md`, `model-setup.md`, and
  `adapters.md`.
- Required guidance:
  - recommend Zod by default;
  - accept validation-only Standard Schemas where permitted;
  - require Standard JSON Schema for tool input/default-loop output;
  - identify official wrapper responsibility and provider subset limitations;
  - never advise passing a validator to `ctx.models.object`;
  - route provider rejection to schema simplification/local validation, not
    silent keyword removal.
- Acceptance: `npm run skills:sync -- --check` passes against the intended
  installed mirror; source and mirror are byte-aligned by the repository's
  sync mechanism, not hand-edited independently.

#### SSI-012 — update the canonical public Harness Handbook

- Repository: `purista`.
- Authority: `specs/50-handbook/00-information-architecture.md`,
  `01-framework-task-flow.md`, and
  `plans/handbook-refactor/harness-storyline-refactor-plan.md`.
- One integrator owns content manifest/navigation/link/build changes. Topic
  workers must not reorder unrelated chapters or overwrite current dirty
  handbook work.
- Canonical content placement:
  - `harness/build-agents/inputs-and-structured-outputs.md` becomes the one
    concept/task owner for Standard Schema validation, Standard JSON Schema
    projection, Zod default, ArkType example, Valibot wrapper example,
    transforms, JSON-only values, and provider subset limitations.
  - `harness/add-capabilities/tools.md` states that tool input must be
    model-projectable and tool output needs validation only; it links to the
    canonical page.
  - `harness/secure-and-govern/guardrails.md` states validation-only support and
    async/fail-closed behavior without duplicating schema setup.
  - `harness/start/requirements-and-installation.md` says Harness uses Zod
    internally but does not re-export it. A Zod-authored application installs
    Zod as its own direct dependency; an application using another validator
    installs that library instead. Valibot's separate converter package is
    classified explicitly for model-facing use.
  - `harness/reference/index.md` links generated schema aliases and errors; it
    no longer says every typed Harness application must install Zod.
  - provider pages own their supported JSON Schema subset/official link and
    distinguish provider rejection from local validator rejection.
  - `harness/upgrade-and-migrate/index.md` owns semver, migration, and rollback.
- Audit all Harness markdown files currently importing Zod. Keep examples Zod
  where Zod is merely the recommended library; change only claims implying it
  is the exclusive contract. Do not churn 25+ snippets into mixed libraries.
- Update generated TypeDoc through the repository build; never edit generated
  API output manually.
- Render and inspect the affected routes at desktop and mobile widths.

#### SSI-013 — align PURISTA framework guidance and canonical skill mirrors

- Repository: `purista`.
- Write owner:
  - the relevant schema explanation on
    `web/src/content/handbook/framework/understand-the-framework/messages-schemas-and-contracts.md`;
  - the attached-agent framework page(s) that currently present Zod as the only
    Harness choice;
  - `skills/purista/references/05-ai-harness-runtime.md` and its generated/core
    mirror through `node scripts/syncPackageSkills.mjs packages/core`.
- Deliverable: distinguish PURISTA service schemas (already Standard Schema)
  from Harness model-facing schemas (Standard Schema plus JSON projection),
  while retaining Zod as the scaffold/default recommendation.
- Acceptance: no duplicated standalone Harness tutorial appears in the
  Framework chapter; no skill requires internal specs; skill audit and knowledge
  audit pass.

### Wave 6 — release and drift closure

#### SSI-014 — full verification and packed consumer matrix

- Repository: both.
- Run from `ai-harness`:

  ```sh
  npm run verify:architecture
  npm run lint
  npm run typecheck
  npm run build
  npm test
  npm run test:coverage
  npm run test:types
  npm run test:contracts
  npm run test:integration
  npm run test:failure
  npm run skills:sync -- --check
  git diff --check
  ```

- Run from `purista`:

  ```sh
  npm run test:unit
  npm run build:api-docs
  npm run audit:api-docs
  npm run audit:handbook
  npm run audit:skills
  npm run audit:knowledge
  node scripts/handbook-snippet-coverage.mjs
  npm run build -w @purista/web
  npm run audit:internal-links -w @purista/web
  npm run test:package-imports
  git diff --check
  ```

- Also run focused Harness package/example tests for every changed boundary and
  a packed consumer fixture with only:
  1. Zod;
  2. ArkType;
  3. Valibot plus its official JSON converter;
  4. the package's declared runtime dependencies.
- Verify supported Node and Bun runtimes and both currently configured
  TypeScript compiler lines. Record environment/version evidence; do not call an
  untested matrix cell supported.
- Re-run semantic searches for public `z.ZodTypeAny`, `z.input`, `z.output`,
  direct `.parse/.safeParse`, `z.toJSONSchema`, "Zod only", and "must install
  zod" across source, declarations, specs, docs, examples, skills, and Handbook.
  Each remaining match must be internal implementation, an intentional Zod-first
  example, a negative test, or historical release evidence.

#### SSI-015 — release decision and rollback record

- Confirm whether all pre-change Zod consumer fixtures remain source-compatible.
- If yes, release as minor with an additive feature note.
- If no, stop; change the spec/release plan to major, publish exact migration
  steps, and obtain owner approval. Do not use overload shims or `any` casts to
  preserve a false compatibility claim.
- Rollback is source-level: revert the public generalized contracts and docs as
  one release unit. No durable storage or data migration is introduced.
- Provider subset problems do not trigger a validator rollback; they are model
  adapter/configuration compatibility issues and remain explicit errors.

## Acceptance matrix

| Scenario | Compile | Build | Runtime | Expected result |
| --- | --- | --- | --- | --- |
| Existing Zod agent/workflow/tool | pass | pass | pass | unchanged behavior and inference |
| Zod schema with JSON-compatible transform | pass | pass | pass | handler sees transformed output; model schema uses input projection |
| Zod schema transforming to `Date` | fail type test where inferable | otherwise fail before propagation | no side effect | JSON-only invariant |
| ArkType workflow input/output | pass | pass | pass | validation only |
| ArkType default-loop output/tool input | pass | pass | pass | standard JSON projection cached |
| Valibot workflow schema | pass | pass | pass | validation only |
| Raw Valibot schema at model-facing boundary | fail type test | fail missing projection in JS/untyped use | no provider call | wrapper required |
| `toStandardJsonSchema(valibotSchema)` at model-facing boundary | pass | pass | pass | converter-owned standard projection |
| Async Standard Schema workflow/guardrail value | pass | pass | pass | validation awaited inside lifecycle budget |
| Validation-only schema as default-loop output | fail type test | fail build in JS/untyped use | no provider call | precise config error |
| Converter throws | compile | fail build | no provider call | `schema_json_projection_failed` |
| Provider rejects supported-standard but unsupported-provider keyword | pass | pass | fail model call | normalized `ModelError`; schema not weakened |
| Direct `ctx.models.object` with explicit JSON Schema | unchanged | unchanged | unchanged | caller owns local validation |
| Memory summary | pass | pass | pass | adapter receives plain JSON Schema; response locally validated |

## Risks and controls

| Risk | Control |
| --- | --- |
| Marketing overclaim: "any validator everywhere" | Boundary matrix and exact trait terminology in types/docs/tests. |
| Provider supports less than generated Draft 2020-12 | Preserve local validation; document official subset; surface provider failure; no silent lowering. |
| Async validation changes ordering or timeout behavior | Explicit lifecycle tests for agents, tools, workflows, and guardrails; await inside existing cancellation/deadline boundaries. |
| Transform input/output direction is reversed | Lock input projection for model-produced values; type/runtime fixtures with differing input/output. |
| Library-specific issues leak content or become non-JSON | Bounded normalization and serialized-error privacy tests. |
| Build-time conversion has side effects or high cost | Compile once, freeze, count converter calls, fail before I/O. |
| Existing Zod users regress due generic variance | Compile the entire pre-change Zod type fixture set and packed consumers; minor release gate becomes major on any unavoidable break. |
| Internal and user-authored schemas are conflated | Keep internal Zod imports; semantic search and package-boundary review target only public authoring paths. |
| Docs duplicate alternative-library examples everywhere | One canonical structured-schema page; Zod-first examples elsewhere with links. |
| Parallel agents edit shared exports/navigation/lockfiles | Single integrator owners and wave gates; ticket scopes generated only after approved manifest. |
| Existing dirty work is overwritten | Baseline gate, path-level ledgers, no broad formatting, and `git diff` review against recorded pre-existing changes. |

## Final recommendation

Proceed with Phase 0. The design is technically feasible, aligns Harness with
PURISTA's validator-neutral philosophy, and does not require provider adapter
coupling. The value is real: users can choose Zod, ArkType, Valibot, or another
compatible library while Harness retains inference, transforms, local runtime
validation, and model JSON Schema generation.

Do not describe or implement it as accepting `StandardSchemaV1` uniformly at
all schema properties. That would be insufficient for tools and structured
model outputs and would move failures into live model calls. The two-trait
contract, build-time projection gate, local revalidation, JSON-only fence, and
provider-subset honesty are the conditions that make the feature safe and
sufficient.
