# Provider-Agnostic Sensitive-Data Guardrails: Spec-Closure and Implementation Plan

**Status:** `IMPLEMENTATION IN PROGRESS — SPEC APPROVED`

**Prepared:** 2026-08-23<br>
**Implementation baseline:** ai-harness commit `1dd9cce` on `feat/nemo-guardrails-harness`<br>
**Affected repositories:** `ai-harness` (primary) and sibling `../purista` (handbook and Harness website)

## Approval and execution record

The repository owner auto-approved the sensitive-data specification on
2026-08-24. [`specs/31-sensitive-data-guardrails.md`](../specs/31-sensitive-data-guardrails.md)
is authoritative and was committed as `aad0dad`
(`spec(guardrails): approve sensitive data adapters`). It supersedes the
previous stop condition in this plan only for the exact provider-neutral port,
Presidio sidecar, and native privacy subset it specifies.

Implementation must follow the approved specification verbatim. In particular,
it must not add cloud SDKs, YAML network settings, provider fallback, generic
recursive JSON scanning, Presidio-parity claims, WASM, or any telemetry content.

Current implementation evidence belongs in the worktree and final verification
record. A native artifact is not release-ready until every required Node/Bun
platform matrix cell and package-assembly gate in spec 31 has passed.

## Goal

Add NeMo-compatible sensitive-data rail configuration to the optional Guardrails addon without coupling `@purista/harness` or `@purista/harness-guardrails` to a model provider, cloud provider, credentials, or network destination.

The first implementation release provides a vendor-neutral TypeScript privacy-adapter port inside `@purista/harness-guardrails` and a local-first Presidio adapter. Presidio originated at Microsoft and is now maintained upstream by the Data Privacy Stack project; applications must pin current explicit upstream release tags rather than retired Microsoft Container Registry images. Applications inject every detector implementation in their composition root. Cloud detector integrations are separately versioned optional packages and are explicitly out of scope for the first release.

The full TypeScript port research is recorded in [`plans/2026-08-24-presidio-typescript-port-feasibility.md`](2026-08-24-presidio-typescript-port-feasibility.md). It concludes that a Presidio Analyzer/Text-Anonymizer parity port is a separate 12–24 engineer-month product program, not an extension of this release.

## Owner-stated decisions — immutable for this plan

These decisions came directly from the repository owner during the 2026-08-23 Guardrails design discussion. The Phase 0 spec author must copy them verbatim into the approved specification; an implementation agent must not reinterpret them.

| ID | Decision |
| --- | --- |
| SD-01 | The architecture is provider-agnostic. No base Harness or base Guardrails package depends on a model or cloud safety provider. |
| SD-02 | Model-backed safety checks continue to use injected Harness model adapters through `ctx.models`; no guardrail YAML creates a model client, supplies credentials, or selects a network destination. |
| SD-03 | Sensitive-data detection is a separate adapter port. The application can bind it to a local service or a cloud implementation without changing policy YAML. |
| SD-04 | The initial production adapter is local-first Microsoft Presidio, deployed behind an application-owned authenticated internal gateway. It is never exposed as an unauthenticated public service. |
| SD-05 | Provider SDKs and service clients live only in their optional integration package. Base packages have no optional peer-dependency magic, dynamic import, vendor credential lookup, or hidden egress. |
| SD-06 | NeMo-shaped YAML remains the portable policy format. Compatible fields are accepted only when their behavior is exactly specified; unimplemented NeMo fields fail validation and are never silently ignored. |
| SD-07 | Content never enters traces, metrics, structured logs, errors, events, snapshots, or test fixtures. Only bounded operational metadata is observable. |
| SD-08 | Detector errors, malformed detector results, cancellation protocol failures, and transformation failures fail closed. There is no implicit fail-open path. |

## First-release boundary

### Included

- `@purista/harness-guardrails`: vendor-neutral privacy-adapter contracts, exact NeMo-shaped sensitive-data config parsing, action factories, explicit value codecs, errors, telemetry instrumentation, deterministic fake, and tests.
- `@purista/harness-guardrails-presidio`: local Presidio REST client adapter using the platform `fetch` API and an injected internal endpoint/client configuration.
- `@purista/harness-guardrails`: integration point that accepts `rails.config.sensitive_data_detection` and re-exports no vendor-specific type.
- Exact support for these NeMo flow names:
  - `detect sensitive data on input`
  - `mask sensitive data on input`
  - `detect sensitive data on output`
  - `mask sensitive data on output`
  - `detect sensitive data on retrieval`
  - `mask sensitive data on retrieval`
- One explicit application binding for tool input/output through an application-provided typed value codec.
- Docs, handbook, website, examples, type tests, observability tests, package verification, and release notes.

### Explicitly excluded

- Python or Colang execution, NeMo dialog/execution rails, generic arbitrary code loading, provider construction, secret resolution, or YAML network endpoints.
- Cloud SDK packages, cloud credential discovery, automatic cloud fallback, egress routing, data-residency selection, quota/retry policy owned by the addon, and direct browser calls to a detector service.
- NVIDIA NIM / GLiNER, Azure AI Language/Content Safety, Google Sensitive Data Protection/Model Armor, and AWS Bedrock Guardrails runtime adapters. Each is a separately approved optional-package proposal after the local release has shipped.
- Presidio `recognizers` configuration in portable YAML. It is provider-specific; accepting and ignoring it would be unsafe. The parser must reject it with a stable diagnostic in v1.
- Recursive “redact every string” behavior. Structured tool values require an explicit codec and selected fields.
- Persistence of detector findings, raw offsets, raw entity text, redacted content, or provider response bodies.

## Package ownership and dependency graph

```text
application composition root
  ├─ @purista/harness                       (existing models, tools, workflows, OTel)
  ├─ @purista/harness-guardrails            (rail lifecycle, privacy port, YAML, actions, codecs)
  └─ @purista/harness-guardrails-presidio
       └─ injected internal Presidio REST client (platform fetch; no cloud SDK)
```

| Package | Owns | Must not own |
| --- | --- | --- |
| `@purista/harness` | Existing generic lifecycle, cancellation, model handles, tool governance, logging, telemetry context, testing adapter | PII terms, detector contracts, Presidio imports, safety thresholds |
| `@purista/harness-guardrails` | Generic flow parsing, ordered action execution, fail-closed rail lifecycle, public `SensitiveDataDetector` port, portable sensitive-data config, flow-to-action compilation, content-safe detector child span, typed codecs and fake | Concrete detector implementation, endpoint, credentials, cloud SDK, provider-specific recognizers |
| `@purista/harness-guardrails-presidio` | Presidio request/response translation and response validation; implementation of the Guardrails public detector port | YAML parsing, global OTel configuration, credential discovery, public gateway, duplicate public privacy contracts |
| Application | Detector instance, auth/endpoint transport, permitted entities, thresholds, codecs, fallback UX, egress/data classification policy | Reimplementing rail ordering or suppressing a required failure |

## Normative contract to place in the new approved spec

Phase 0 must create `specs/31-sensitive-data-guardrails.md`, update the referenced core specs, and make the following contract authoritative. An implementation agent follows this text exactly; it does not select alternate names, semantics, or failure behavior.

### 1. Portable YAML schema and exact compatibility rules

The existing `NeMoGuardrailsConfig` gains `rails.config.sensitive_data_detection`. Its supported shape is exactly:

```yaml
rails:
  config:
    sensitive_data_detection:
      input:
        entities: [PERSON, EMAIL_ADDRESS]
        mask_token: "<MASKED>"
        score_threshold: 0.6
      output:
        entities: [PERSON, EMAIL_ADDRESS]
        mask_token: "<MASKED>"
        score_threshold: 0.6
      retrieval:
        entities: [PERSON, EMAIL_ADDRESS]
        mask_token: "<MASKED>"
        score_threshold: 0.6
  input:
    flows: ["mask sensitive data on input"]
  output:
    flows: ["detect sensitive data on output"]
```

Rules:

1. `input`, `output`, and `retrieval` are the only valid sensitive-data configuration phases in v1. `tool_input` and `tool_output` deliberately reuse the relevant input/output policy and require an explicit application binding; no fourth or fifth YAML policy branch is introduced.
2. A configured phase contains `entities`, `mask_token`, and `score_threshold`; all are required. `entities` is a non-empty list of unique non-empty ASCII-uppercase identifiers (`[A-Z][A-Z0-9_]{0,63}`). `mask_token` is a non-empty string of at most 128 UTF-16 code units. `score_threshold` is a finite number in `[0, 1]`.
3. The parser accepts no other sensitive-data keys. In particular `recognizers`, `language`, deployment URLs, provider names, credentials, and arbitrary provider payloads reject with `GuardrailsConfigError` and `reason: 'unsupported_sensitive_data_field'`.
4. Each of the six listed flow names has one exact phase. A flow in another rail phase rejects with `reason: 'sensitive_data_flow_phase_mismatch'`. A sensitive-data flow without its phase configuration rejects with `reason: 'sensitive_data_policy_missing'`.
5. The source YAML defines policy only. It cannot choose a detector, endpoint, model, credential, local/cloud mode, timeout, retry, or network destination.
6. Existing unknown rail categories and unsupported executable NeMo features retain their present rejection behavior.

### 2. Vendor-neutral TypeScript port

The public port belongs to `@purista/harness-guardrails`, not to a generic integration package. The Presidio package consumes it through a peer dependency and exports only its concrete adapter constructor and implementation-specific setup types. The Phase 0 spec must give the final source-file/export locations and TypeScript declarations, including TSDoc and type-test expectations.

```ts
type SensitiveDataExecutionMode = 'local' | 'cloud'
type SensitiveDataOperation = 'detect' | 'mask'

interface SensitiveDataDetector {
  readonly id: string
  readonly executionMode: SensitiveDataExecutionMode
  inspect(request: SensitiveDataInspectionRequest): Promise<SensitiveDataInspectionResult>
}

interface SensitiveDataInspectionRequest {
  readonly text: string
  readonly entities: readonly string[]
  readonly scoreThreshold: number
  readonly signal: AbortSignal
}

interface SensitiveDataFinding {
  readonly category: string
  readonly start: number
  readonly end: number
  readonly score?: number
}

interface SensitiveDataInspectionResult {
  readonly findings: readonly SensitiveDataFinding[]
  readonly usage?: Readonly<Record<string, number>>
}
```

Mandatory validation:

- `id` is a deployment-controlled non-empty identifier; it is never derived from a URL, token, request, or provider response.
- Findings are sorted by ascending `start`, have `0 <= start < end <= request.text.length`, do not overlap, have an allowed configured category, and have finite score in `[0, 1]` when supplied.
- Invalid results fail closed with a dedicated stable `GuardrailEvaluationError` reason. Raw detector payloads and source text are never included in the error cause metadata.
- `usage` is an optional bounded numeric map from a provider. Its keys and maximum cardinality must be fixed by the approved spec before exposure. It is not token usage and is never copied onto LLM metric names.

### 3. Detection, masking, and structure preservation

1. A `detect` flow returns `allow` when there are no findings and returns `block` with `reasonCode: 'sensitive_data_detected'` when findings exist.
2. A `mask` flow returns `allow` when there are no findings. With findings, it replaces every finding span with that phase policy’s `mask_token` and returns `transform` with `reasonCode: 'sensitive_data_masked'`.
3. Findings must be applied from the end of a string toward its beginning. This preserves offsets calculated against the original text.
4. Input/output strings use the built-in string codec. Retrieval uses an approved, existing retrieval chunk text field only; Phase 0 must name it after inspecting the current public type.
5. Tool input and tool output use an application-supplied `SensitiveDataValueCodec<T>`. The codec identifies its selected string fields and reconstructs the same schema-compatible value after replacement. A missing codec, selection failure, reconstruction failure, or type mismatch fails closed before a tool side effect or continuation.
6. The addon never recursively traverses JSON values and never changes field names, array cardinality, numeric values, booleans, nulls, or unselected strings.
7. The public action factory is named `createSensitiveDataActions`. It returns application-owned named `GuardrailAction` objects only for explicitly configured flow names. The application registers those actions with `defineGuardrails`; no magic auto-registration is introduced.

### 4. Failure, cancellation, timeout, and retry rules

| Condition | Required result | Span status | Stable reason / error class |
| --- | --- | --- | --- |
| No findings | allow | `UNSET` | none |
| Detect finding | block | `UNSET` | `sensitive_data_detected` |
| Mask finding | transform | `UNSET` | `sensitive_data_masked` |
| Detector rejects, times out, is cancelled incorrectly, returns malformed/out-of-policy data, or codec fails | terminal failure, never model-visible tool error | `ERROR` | `GUARDRAIL_EVALUATION_ERROR` plus approved bounded reason |
| Presidio returns an unauthenticated/forbidden/invalid response | terminal failure | `ERROR` | approved bounded transport reason |

The existing 10-second guardrail action deadline remains the single timeout budget in the first release. The sensitive-data adapter does not create a second timeout, retry policy, backoff loop, fallback provider, or fail-open mode. The `AbortSignal` from the existing action context is passed directly to the detector.

### 5. Logging, OpenTelemetry, and cost attribution

The existing outer `evaluate_guardrail {rail.id}` span and `harness.guardrail.*` metrics remain unchanged. Sensitive-data inspection emits one nested child span named `harness.sensitive_data.inspect`; it has `openinference.span.kind='GUARDRAIL'` in modes where OpenInference attributes are enabled.

The approved spec must add the following bounded attributes and no content attributes:

| Attribute | Value |
| --- | --- |
| `harness.sensitive_data.detector.id` | injected detector id |
| `harness.sensitive_data.execution_mode` | `local` or `cloud` |
| `harness.sensitive_data.operation` | `detect` or `mask` |
| `harness.sensitive_data.outcome` | `allow`, `block`, `transform`, or `error` |
| `harness.sensitive_data.finding_count` | bounded integer count |
| `harness.sensitive_data.categories` | sorted, de-duplicated configured category identifiers, bounded by spec |
| `error.type` | only on failure |

It must additionally add `harness.sensitive_data.inspections` (counter) and `harness.sensitive_data.duration` (seconds histogram) with the same content-free dimensions. Detector-reported `usage` may be recorded only after the approved key/cardinality rules exist; it must use a `harness.sensitive_data.*` instrument and never `gen_ai.*`, `llm.*`, or `{token}` units.

There is no detector model/token/cost metric in the first release. When a separate model-backed rail runs through `ctx.models`, its nested standard Harness `LLM` span remains the sole owner of provider/model names, `gen_ai.usage.*`, `llm.token_count.*`, and `gen_ai.client.token.usage`. The parent-child relationship is the cost attribution mechanism.

### 6. Presidio integration contract

- The adapter accepts an injected `PresidioClient` or injected internal transport; it does not read environment variables, construct credentials, discover hosts, or configure TLS.
- The default transport implementation uses `fetch`, receives a prevalidated internal base URL and caller-supplied headers from the application composition root, and supports only the exact Presidio API calls/response shapes approved in the spec.
- All HTTP status and payload validation produces bounded errors. It must not attach body text, entity text, offsets, headers, endpoints, authorization values, or raw payloads to observability data.
- Deployments terminate authentication, authorization, tenant isolation, and network restriction at the application-owned gateway. The adapter documentation includes a local Docker/service example with a loopback or internal-only binding; it does not publish a public service recipe.
- Presidio entity identifiers are mapped explicitly. Any requested portable entity that has no documented Presidio mapping fails during application setup, not during a live request.

## Phase 0 — specification and readiness closure (completed)

**Owner:** spec author / repository owner<br>
**Completed:** 2026-08-24, recorded in `specs/31-sensitive-data-guardrails.md`
and commit `aad0dad`. The owner’s automatic approval is the approval evidence
for this repository. The readiness-record process described below is retained
as historical planning context; it is not a new implementation blocker.

1. Create `specs/31-sensitive-data-guardrails.md` from the normative contract above. It must include scope, non-goals, machine-readable schema/contract, ownership, sequence diagrams for input/tool/retrieval paths, failure matrix, privacy rules, performance bounds, migration rules, and acceptance criteria.
2. Update `specs/00-overview.md`, `specs/02-harness-config.md`, `specs/07-tools.md`, `specs/09-agents.md`, `specs/13-public-api.md`, `specs/14-otel-conventions.md`, `specs/15-error-catalog.md`, `specs/16-testing.md`, `specs/17-implementation-plan.md`, `specs/30-guardrails.md`, and `specs/README.md` with exact authoritative cross-references. If any listed file does not exist, stop and record that repository fact in the readiness review; do not substitute a different file silently.
3. Add a unique `follow_up_waves` entry to `specs/.readiness-report.yaml` named `2026-08-23-provider-agnostic-sensitive-data-guardrails`. Bind this plan’s owner-stated decisions and human approval evidence to the exact spec list.
4. Repair or introduce the planning workflow prerequisites named by the readiness review: manifest digest evidence, checklist-walk evidence, end-to-end-definition evidence, current-dependency-research evidence, and representation-reuse evidence. Do not mark them passed without links to the concrete artifacts.
5. Run the project’s deterministic spec/readiness checks, record exact commands and their output location, and request a semantic/readiness review. All gates must be `passed`; a legacy checker exception is acceptable only when the report names the pre-existing defect, proves the new scope passes its own deterministic check, and receives repository-owner approval.
6. Completed: repository-owner approval changed this plan status to
`IMPLEMENTATION IN PROGRESS`.

## Implementation waves

The waves below are intentionally ordered. A worker must complete and verify one wave before opening the next. It must not combine waves, simplify a boundary, or introduce an excluded cloud adapter.

### Wave 1 — portable configuration and public contracts

**Files to create or update (final names must be confirmed by Phase 0):**

- `packages/harness-guardrails/src/config.ts`
- `packages/harness-guardrails/src/index.ts`
- `packages/harness-guardrails/src/errors.ts`
- `packages/harness-guardrails/src/privacy/contracts.ts`
- `packages/harness-guardrails/src/privacy/config.ts`
- `packages/harness-guardrails/src/privacy/errors.ts`
- `packages/harness-guardrails/test/guardrails.test.ts`
- `packages/harness-guardrails/type-tests/sensitive-data-typing.ts`
- root workspace/package/version configuration required to register the package

**Required outcome:** parser accepts only the exact YAML schema; public types compile; bad shapes/unknown keys/unsupported `recognizers`/phase mismatches have stable error reasons; no network code exists.

**Required evidence:** parser unit tests, public export test, type test, package build, and content-free error assertions.

### Wave 2 — detector action factory, codecs, and OTel contract

**Files to create or update:**

- `packages/harness-guardrails/src/privacy/actions.ts`
- `packages/harness-guardrails/src/privacy/codecs.ts`
- `packages/harness-guardrails/src/privacy/telemetry.ts`
- deterministic fake detector and focused tests under `packages/harness-guardrails/test/`
- `packages/harness/testing` only if an existing recording telemetry capability cannot express the approved exact assertions; otherwise reuse `RecordingTelemetry`

**Required outcome:** exact detect/mask behavior for input, output, retrieval, and explicitly bound tool values; ordered reverse-offset mask replacement; cancellation propagation; fail-closed malformed data; no recursive JSON traversal; no raw content in traces/logs/errors/fixtures.

**Required evidence:** deterministic test matrix covers allow, block, transform, invalid findings, detector rejection, timeout, abort, codec failure, phase mismatch, tool pre-side-effect block, retrieval transform, span hierarchy, span status, attributes, counter/histogram dimensions, and privacy negative assertions.

### Wave 3 — local Presidio adapter

**Files to create:**

- `packages/harness-guardrails-presidio/package.json`
- `packages/harness-guardrails-presidio/tsconfig.json`
- `packages/harness-guardrails-presidio/vitest.config.ts`
- `packages/harness-guardrails-presidio/src/index.ts`
- `packages/harness-guardrails-presidio/src/presidio-client.ts`
- `packages/harness-guardrails-presidio/src/presidio-detector.ts`
- `packages/harness-guardrails-presidio/src/errors.ts`
- deterministic tests under `packages/harness-guardrails-presidio/test/`

**Required outcome:** an injected internal client maps only approved categories, validates all Presidio response data before returning it, honors the inherited abort signal, and implements the public `SensitiveDataDetector` exported by `@purista/harness-guardrails`. It emits no endpoint/body/PII telemetry. The package has no `@azure/*`, `@google-cloud/*`, `@aws-sdk/*`, NVIDIA SDK, credential-provider, or environment-variable dependency; it declares `@purista/harness-guardrails` as a peer dependency.

**Required evidence:** mock-transport contract tests for successful detection, empty result, unknown entity mapping at setup, non-2xx response, malformed response, abort, and observability privacy. One integration test runs only against an explicitly opt-in local test service and is excluded from default unit tests.

### Wave 4 — composition-root examples, workflows/tools/skills, and docs

**Files to create or update:**

- `examples/guardrails/` in `ai-harness`
- `docs/guides/guardrails.md`, `docs/reference/public-api.md`, and related configuration/observability guides in `ai-harness`
- `skills/ai-harness/` and all mandatory referenced skill pages
- `../purista/web/src/content/handbook/2_building_business-logic/ai/guardrails.md`
- `../purista/web/src/pages/harness/guardrails.astro`
- relevant `../purista/web/src/data/nav.ts` / markdown navigation / observability reference files after inspection

**Required outcome:** examples demonstrate standard agent flow, a workflow invocation, tool input protection before side effect, tool output protection before model continuation, a skill/tool composition note, retrieval filtering, local Presidio composition-root binding, custom codec use, block UX, transform semantics, trace/cost explanation, and privacy rules. Examples use fake/local injected transport only and contain no secrets or public endpoint.

**Required evidence:** examples run deterministically without network; docs links and snippets validate; both handbook and Harness website builds pass in their owning repositories.

### Wave 5 — release verification and guarded rollout

1. Update release/version metadata for all changed packages using the repository’s established release mechanism; no version is guessed or manually diverged.
2. Run the exact repository commands required by the approved spec, plus the baseline suite below.
3. Review the complete diff for accidental raw-content capture, package-boundary leaks, public endpoint examples, environment credential discovery, and unsupported YAML acceptance.
4. Create a release note with migration instructions: existing NeMo config directories without `sensitive_data_detection` are unchanged; directories with unsupported fields fail validation; applications explicitly add/register the detector action factory and codec.
5. Do not add cloud adapters during the release branch. They require a new approved wave after local adapter evidence is accepted.

## Mandatory verification baseline after implementation

Run from `/Users/sebastianwessel/projekte/@purista/ai-harness` unless the command names the sibling repository:

```sh
npm run lint
npm run typecheck
npm run test --workspace @purista/harness-guardrails
npm run test --workspace @purista/harness-guardrails-presidio
npm run test:types --workspace @purista/harness
npm run test:contracts
npm run test:failure
npm run test:integration
npm run build
npm run verify:architecture
git diff --check
```

The implementation spec must replace any command that does not exist after package registration with the exact package-local command. It must never delete a verification requirement merely because a script fails or is slow.

Run documentation checks in `/Users/sebastianwessel/projekte/@purista/purista` using the current website scripts after inspecting that repository’s `package.json`; record the exact commands in the Phase 0 acceptance criteria. The expected minimum is handbook/content audits and a production website build.

## External provenance and dependency policy

Phase 0 must preserve these primary-source links in the approved spec. They justify research, not runtime coupling:

- [NVIDIA NeMo Guardrails sensitive-data configuration](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/configuration-reference)
- [NVIDIA NeMo Presidio integration](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/third-party/presidio)
- [Microsoft Presidio repository and license](https://github.com/microsoft/presidio)
- [AWS Bedrock independent ApplyGuardrail API](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html)
- [Google Cloud Sensitive Data Protection Node.js reference](https://docs.cloud.google.com/nodejs/docs/reference/dlp/latest)
- [Azure AI Language PII API](https://learn.microsoft.com/en-us/javascript/api/%40azure/ai-text-analytics/textanalyticsclient?view=azure-node-latest)

The first release adds no cloud SDK. Any later cloud adapter must be a separate, owner-approved plan/spec wave that includes: exact package name and version policy, official supported SDK, API version, data handling/egress classification, authentication ownership, retry and timeout interaction with the existing guardrail deadline, region/residency behavior, cost/usage metadata semantics, integration tests, and an explicit non-default activation mechanism. Google Model Armor is Preview and is prohibited from a production-default adapter until a later approval explicitly overrides that rule. NVIDIA NIM remains a discovery spike until its stable endpoint contract is pinned from NVIDIA primary documentation.

## Autonomous-agent stop conditions

An agent must stop and request a new approved spec/review instead of making a local decision when it encounters any of the following:

- A desired NeMo field or flow is not one of the exact v1 fields/flows above.
- The current public retrieval type lacks an unambiguous text field.
- A tool value cannot be safely reconstructed by a typed explicit codec.
- Presidio’s documented API or entity mapping differs from the approved contract.
- A package would need credentials, an environment-variable lookup, a URL in YAML, an additional timeout/retry loop, a cloud SDK, or a dependency in a base package.
- A telemetry attribute, metric, or log field would contain or infer raw content, URLs, headers, user identifiers, request IDs, entity text, offsets, provider bodies, or unbounded categories.
- A test requires a live network service to prove default behavior.
- The sibling Purista documentation repository is on a different base branch or has conflicting user changes.
- Any Phase 0 readiness gate is not explicitly `passed` with linked evidence.

## Historical completion criteria for changing this plan to `EXECUTABLE`

All of the following must be true and recorded in `specs/.readiness-report.yaml`:

- `specs/31-sensitive-data-guardrails.md` exists, contains the normative rules above, and is linked from the relevant existing specs.
- The owner-stated decision ledger is recorded as confirmed decisions, with no open or blocking decisions.
- The package names, public export paths, exact errors, metric instrument names, attribute cardinality caps, structured value codec protocol, retrieval text field, Presidio API/version/entity map, and test fixture strategy are fixed in the canonical spec.
- Manifest/checklist/E2E/dependency-research/representation-reuse gates have machine-readable evidence.
- Security/privacy, observability, supply-chain, migration, contradiction, deterministic, and semantic readiness gates all pass.
- A repository owner has approved that exact spec scope after review.

This historical gate was satisfied by the owner-approved spec 31. The remaining
release gate is the deterministic verification and platform evidence required
by that specification.
