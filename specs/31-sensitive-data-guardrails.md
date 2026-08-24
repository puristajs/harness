# Sensitive-data Guardrails

**Status:** approved implementation specification, 2026-08-24. The repository
owner explicitly approved this specification before implementation in the
initiating task. It is the more-specific authority for sensitive-data rails and
supersedes the no-invention gate in [30-guardrails.md](./30-guardrails.md) only
for the capabilities defined here.

## Purpose and package ownership

This specification adds a provider-neutral sensitive-data detector port to the
optional Guardrails addon. It deliberately does **not** add a privacy feature to
`@purista/harness`, a detector server, a provider SDK, credential discovery, or
network configuration in policy YAML.

| Owner | Owns | Must not own |
| --- | --- | --- |
| `@purista/harness` | Existing interceptor lifecycle, model adapters, cancellation, logs, telemetry, workflows and tool governance | PII vocabulary, detector API, Presidio, native recognizers |
| `@purista/harness-guardrails` | Public detector port, strict portable config, flow actions, typed value codecs, enforcement and privacy telemetry | An endpoint, credentials, a detector implementation, cloud SDKs |
| `@purista/harness-guardrails-presidio` | Original Presidio Analyzer REST translation, response validation and Unicode-index conversion | YAML parsing, global OTel configuration, endpoint discovery, retries, a public server |
| `@purista/harness-guardrails-native-privacy` | Rust/Node-API local recognizer subset and its prebuilt platform artifacts | JavaScript fallback, model/NER downloads, Presidio-parity claims, network access |
| Application composition root | Detector choice, endpoint/auth transport, policy YAML, permitted entity categories, codecs and user-facing fallback | Disabling required failure handling or reimplementing rail ordering |

The two detector packages are optional, independently published packages. The
base addon imports neither of them and has no optional-peer dynamic import.
All packages are ESM-only and support Node.js and Bun as specified below.

## Capability matrix

| ID | Outcome | Deterministic evidence |
| --- | --- | --- |
| SD-01 | Portable policy can detect or mask sensitive input, output and retrieval content | parser and action fixtures |
| SD-02 | Every detector is injected through one provider-neutral public port | compile-only consumer fixture |
| SD-03 | A configured match blocks or masks before the protected boundary | agent, tool and retrieval side-effect tests |
| SD-04 | Sidecar faults, malformed responses and codec faults fail closed without content leakage | error and recording-telemetry tests |
| SD-05 | Original Presidio can be used through an application-owned internal HTTP(S) endpoint | public scripted-sidecar contract suite |
| SD-06 | Native privacy supports documented deterministic entity subset in Node and Bun | Node and Bun integration matrix |
| SD-07 | Traces, metrics and logs describe enforcement without recording content or duplicate LLM cost data | OTel/log redaction assertions |

## Public detector port

`@purista/harness-guardrails` exports the following types. Offsets use
JavaScript UTF-16 code-unit indexes: `text.slice(start, end)` identifies exactly
the detected range. This is the contract for every adapter, independent of the
indexing convention used by its backend.

```ts
export type SensitiveDataExecutionMode = 'local' | 'cloud'

export interface SensitiveDataFinding {
  /** Deployment-controlled entity category; never matched text. */
  readonly category: string
  /** Inclusive UTF-16 offset into the supplied request text. */
  readonly start: number
  /** Exclusive UTF-16 offset into the supplied request text. */
  readonly end: number
  /** Detector confidence in [0, 1] when the backend reports one. */
  readonly score?: number
}

export interface SensitiveDataInspectionRequest {
  readonly text: string
  readonly entities: readonly string[]
  readonly scoreThreshold: number
  readonly signal: AbortSignal
}

export interface SensitiveDataInspectionResult {
  readonly findings: readonly SensitiveDataFinding[]
}

export interface SensitiveDataDetector {
  /** Stable deployment-controlled identifier, maximum 128 ASCII characters. */
  readonly id: string
  readonly executionMode: SensitiveDataExecutionMode
  /** Optional exact capability declaration for construction-time validation. */
  readonly supportedEntities?: readonly string[]
  inspect(request: SensitiveDataInspectionRequest): Promise<SensitiveDataInspectionResult>
}
```

`inspect` receives the action budget's abort signal. It MUST stop its own
work when that signal aborts and MUST NOT retry, fall back, log, emit, persist,
or send the input to any undeclared destination. It returns no matched text,
request metadata, endpoint, headers, response body, raw backend offset or
provider identifier. A result is invalid when a category is not requested,
offsets are non-integers/out of range/empty, score is out of range, or ranges
overlap. Invalid results are enforcement errors, not no-match results.

`createSensitiveDataActions(options)` is the sole built-in action factory. It
requires a `SensitiveDataDetector` and returns ordinary `GuardrailActions`; it
does not change the existing `defineGuardrails` construction or Harness core.
If `supportedEntities` is declared, unknown configured entities fail at action
factory construction with `GUARDRAILS_CONFIG_ERROR`. The public port remains
open to detector packages other than Presidio and native privacy.

## Deterministic testing surface

`@purista/harness-guardrails/testing` MUST provide the deterministic
`FakeSensitiveDataDetector` for application tests. It records inspection
requests and supports queued valid findings, complete inspection results, and
intentional failures. It has no built-in recognition, timing, network access,
fallback, telemetry, logging, or content redaction behavior. Tests choose the
exact outcome; a missing queued result is an empty finding list. The fake may
declare the same stable id, execution mode, and capabilities as production
detectors, so construction-time capability validation is testable.

`@purista/harness-guardrails-presidio/testing` MUST provide a deterministic
`FakePresidioSidecar`. It is a scripted `fetch` implementation for the one
supported Presidio `POST /analyze` wire contract, not an imitation of
Presidio's recognizer or NLP behavior. It records test-only outbound requests
and supports queued HTTP responses and transport failures. It defaults to a
successful empty Analyzer response. Test-recorded request and response content
MUST remain in memory only; it must never be attached to telemetry, logs,
errors, snapshots, or production package paths.

Both testing subpaths are public development-only helpers. They are the
default for unit, workflow, tool, skill, and adapter-contract tests; a live
Presidio sidecar is reserved for explicitly configured integration tests.

## Portable policy and configuration

`NeMoGuardrailsConfig.rails.config.sensitive_data_detection` has exactly this
strict shape:

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
```

Each configured phase is optional. Within a configured phase, `entities` is a
non-empty, unique list of uppercase ASCII identifiers (`[A-Z][A-Z0-9_]{0,63}`),
`mask_token` is a non-empty string of at most 128 UTF-16 code units, and
`score_threshold` is a finite number in `[0, 1]`. Unknown keys, a non-object
phase, `recognizers`, `language`, provider names, endpoint URLs, credentials,
or a flow whose phase lacks the matching policy are rejected with a
path-qualified `GUARDRAILS_CONFIG_ERROR`. The parser never accepts and ignores
a policy field.

The exact supported flow names are:

| Phase | Detect flow | Mask flow |
| --- | --- | --- |
| `input` | `detect sensitive data on input` | `mask sensitive data on input` |
| `output` | `detect sensitive data on output` | `mask sensitive data on output` |
| `retrieval` | `detect sensitive data on retrieval` | `mask sensitive data on retrieval` |

There is no generic string matching action and no implicit binding from a flow
name to a detector. The application binds the returned actions explicitly:

```ts
const rails = defineGuardrails({
  config,
  actions: createSensitiveDataActions({ detector })
})
```

`tool_input` and `tool_output` deliberately have no portable policy key or
flow in this release. They may reuse a selected `input` or `output` policy only
through `createSensitiveDataActions({ toolInput, toolOutput })` and an explicit
application-owned `SensitiveDataValueCodec<T>`. This prevents accidental
recursive redaction of arbitrary JSON.

```ts
export interface SensitiveDataValueCodec<T extends JsonValue = JsonValue> {
  readonly id: string
  extract(value: T): readonly SensitiveDataTextSegment[]
  replace(value: T, replacements: readonly SensitiveDataReplacement[]): T
}

export interface SensitiveDataTextSegment {
  readonly id: string
  readonly text: string
}

export interface SensitiveDataReplacement {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly value: string
}
```

Segment identifiers are deployment-controlled and no longer than 128 ASCII
characters. Codec exceptions, duplicate/unknown segment identifiers and invalid
replacement coordinates are terminal evaluation failures. Codecs are never
called for unconfigured tool phases.

## Enforcement semantics

For a normal string value, detect invokes `detector.inspect` once with the
configured entities and threshold. An empty finding list allows the rail. One
or more findings makes a detect flow block with deployment-controlled
`reasonCode: 'sensitive_data_detected'`. A mask flow replaces every finding
with the configured `mask_token`, processing sorted findings from highest start
offset to lowest so no previously validated coordinate shifts. A masked result
uses `reasonCode: 'sensitive_data_masked'`.

For retrieval, each caller-owned string chunk is independently inspected in
input order; non-string chunks are rejected instead of coerced. Detect blocks
the retrieval operation on the first finding. Mask returns an equal-length
chunk list with only affected chunks replaced. The detector is never invoked
for an empty string unless the adapter explicitly documents an empty-string
semantic; the built-in action factory simply allows it.

Input remains before transcript/model work; output remains before event/output
validation/persistence; tool hooks retain the ordering defined in spec 30.
Thus a workflow-attached agent gets the same protection. Skills do not form a
new boundary: skill text is protected when it enters a guarded model input, and
skill tools are protected only through their selected explicit tool codec.

Cancellation, detector rejection, malformed result, non-cooperative abort,
codec fault and replacement validation fault all fail closed as
`GUARDRAIL_EVALUATION_ERROR` with reason `sensitive_data_detector_failed`,
`sensitive_data_invalid_result`, `sensitive_data_codec_failed`, or
`action_timeout`. None may be turned into a model-visible tool error or an
implicit allow. A `GUARDRAIL_BLOCKED` standalone retrieval error carries only
the existing rail id, retrieval phase and `sensitive_data_detected` reason.

## Presidio sidecar adapter

`@purista/harness-guardrails-presidio` implements `SensitiveDataDetector` using
the original Presidio Analyzer REST `POST /analyze` operation. It exposes a
factory whose endpoint, fixed language (default `en`), optional static headers,
and `fetch` implementation are all provided at the application composition
root. It performs no environment lookup, credential discovery, default URL,
retry, redirect-following policy, or cloud fallback.

The deployment is an application-owned internal Presidio service behind an
authenticated gateway. HTTP is permissible only on a trusted private network;
HTTPS is required whenever the network boundary is not trusted. A browser
application MUST call an application backend, never the adapter directly.
The adapter sends exactly the caller text, configured entities and threshold to
the injected endpoint. Endpoint, headers, HTTP status body, response body and
error body are never included in public errors, telemetry or logs.

The adapter validates every Presidio item before returning it. Presidio's Python
code-point offsets are converted to this specification's UTF-16 offsets before
the result crosses the public port. Conversion tests MUST cover astral Unicode,
combining sequences, zero/malformed bounds, unknown entities and overlapping
ranges. Unexpected 2xx shape, non-2xx, malformed JSON, aborted fetch, and
invalid offset conversion all reject without content and are classified by the
base action factory as a terminal detector failure.

## Native privacy adapter

`@purista/harness-guardrails-native-privacy` provides an optional local
`SensitiveDataDetector` built in Rust and exposed only through stable Node-API
using `napi-rs`. It is intentionally a deterministic recognizer subset, not a
TypeScript or Rust port of Presidio Analyzer/Text Anonymizer and not an NER
model runtime. Version 1 supports exactly:

```text
EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IP_ADDRESS, IBAN_CODE, US_SSN, URL
```

It MUST declare that set in `supportedEntities`; an unsupported requested
entity causes construction-time configuration failure. In particular `PERSON`,
organization/location entities, custom recognizers, NLP/ML recognizers,
remote model download and Presidio recognizer YAML are out of scope. Applications
requiring those entities use the optional Presidio sidecar or another injected
detector.

The native package has one ESM JavaScript loader and prebuilt `.node` artifacts
for `darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`,
`win32-x64-msvc`, and `win32-arm64-msvc`. It targets the Node-API ABI only: no
V8/Node C++ API, `NAPI_EXPERIMENTAL`, Bun FFI, WASM fallback or postinstall
compiler. Unsupported runtime/platform/ABI is a clear startup error; it cannot
silently downgrade to JavaScript or remote execution.

Node.js (the repository's supported `>=24.15.0`) and the current supported Bun
release are release targets. Before publishing, every artifact must pass the
same black-box contract under `node` and `bun`: module import, UTF-8 input,
astral-Unicode UTF-16 ranges, valid and invalid arguments, all supported
entities, no-match, overlapping-match normalization, concurrent calls,
cancellation and content-free error behavior. CI builds the release matrix on
macOS, Linux and Windows, and validates Node plus Bun on each host where Bun
supports that architecture. A failed Bun probe blocks native-package release;
the sidecar package remains independently usable.

The Rust engine accepts no user-defined patterns and enforces explicit maximum
input length, finding count and work bounds. It returns only validated UTF-16
findings. It neither reads files nor accesses the network. Security updates to
Rust, `napi-rs` and compiled dependencies follow the normal dependency update
and native artifact rebuild/re-sign/retest process.

## Telemetry, logging and cost attribution

The existing outer `evaluate_guardrail {rail.id}` span remains the enforcement
span and retains spec 30's GUARDRAIL shape. Each sensitive-data inspection adds
a child span named `harness.sensitive_data.inspect` with
`openinference.span.kind='GUARDRAIL'` and exactly these bounded, content-free
attributes:

```text
harness.sensitive_data.detector.id
harness.sensitive_data.execution_mode             // local | cloud
harness.sensitive_data.operation                  // detect | mask
harness.sensitive_data.outcome                    // allow | block | transform | error
harness.sensitive_data.finding_count              // integer, bounded at 100
harness.sensitive_data.categories                 // sorted unique configured categories, <=16
error.type                                        // failures only
```

It records `harness.sensitive_data.inspections` (counter) and
`harness.sensitive_data.duration` (seconds histogram) with the same safe
dimensions. Blocks and transformations are successful enforcement decisions and
leave span status `UNSET`; detector/codec/validation faults set `ERROR`.
Structured logs occur only for block, transform and error and carry the same
safe identity/outcome fields.

No span, log, metric, event, error, fixture, snapshot or native error may
contain source text, masked text, entity text, offsets, source URL, endpoint,
headers, request/response payloads, user identity, session/run IDs, provider
request IDs or credentials. Sensitive-data inspections are not LLM calls and
MUST NOT emit `gen_ai.*`, `llm.*`, token-use, model or cost attributes. A
model-backed guardrail action retains the existing nested standard LLM span;
that span alone owns model/provider identity and reported input/output/total
token usage, so normal trace hierarchy provides correct cost attribution
without duplicate metrics.

## API, package and release evidence

The base package exports `createSensitiveDataActions`, all types in the public
port, `SensitiveDataValueCodec`, `SensitiveDataTextSegment`,
`SensitiveDataReplacement`, and a deterministic `FakeSensitiveDataDetector`
from its testing subpath. The Presidio package additionally exports
`FakePresidioSidecar` from its testing subpath. Production adapter entrypoints
export only their factory and adapter options; neither redefines the port.

All exported TypeScript APIs require TSDoc with a small safe example. Public
documentation must cover policy setup, local Presidio deployment boundary,
native subset/capabilities, Node/Bun support, workflows, tools/codecs, skills,
retrieval, diagnostics, error handling and trace/cost interpretation. It must
state clearly that samples contain synthetic data only.

Release requires root lint/typecheck/build/test/coverage, base parser/action/
telemetry tests, Presidio fake-transport tests, native Node and Bun black-box
tests, public fake-detector/sidecar behavior tests, cross-platform artifact
checks, package dry-run checks, docs link/build
checks and skill/knowledge audits. CI must verify the published package file
allowlist includes the loader and matching artifacts but excludes source,
credentials, fixtures containing content, and unreviewed binaries.

## No-invention boundary

Stop and obtain a new approved specification before adding a cloud detector
package, automatic retry/fallback, browser direct networking, custom Presidio
recognizers, a Presidio-parity port, a WASM distribution, language selection in
portable YAML, persistence/auditing of findings, content capture, or changes to
the supported native entity set. A proposal must explicitly define ownership,
security, privacy, telemetry, packaging, Node/Bun compatibility and release
evidence.
