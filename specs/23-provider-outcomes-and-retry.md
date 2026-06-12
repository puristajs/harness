# Provider outcomes and retry

**Purpose.** Defines provider-neutral finish reasons, provider outcome metadata,
model retry policy, active/deferred retry classification, SDK retry boundaries,
and adapter acceptance criteria. This spec extends [06-models](./06-models.md),
[14-otel-conventions](./14-otel-conventions.md), and
[15-error-catalog](./15-error-catalog.md).

## Requirements

- POR-01: Users express retry intent as `retry?: boolean | ModelRetryPolicy`
  on a model alias, alias defaults, or per-call `call` options. The public API
  MUST NOT expose provider-strategy modes such as `sdk` or `harness`.
- POR-02: `retry: true` is the default. It actively retries short transient
  outages and rate limits within bounded active budgets. It MUST NOT sleep for
  hours or days inside an active invocation.
- POR-03: `retry: false` disables harness-managed retry and first-party
  adapters MUST disable provider SDK retries by default where the official SDK
  exposes a stable option. Users may still pass explicit SDK retry options as
  provider-specific escape hatches.
- POR-04: Long provider retry instructions are classified as deferred retry
  metadata and surfaced as typed model errors unless a future scheduler/durable
  integration explicitly handles them.
- POR-05: Streaming retries are allowed only before the first user-visible
  stream chunk has been yielded. After a delta/tool/partial chunk is emitted,
  failures MUST surface as errors without replaying hidden duplicate output.
- POR-06: Adapters MUST preserve provider finish/status details while mapping
  into the normalized `FinishReason` enum.
- POR-07: No prompts, outputs, tool payloads, credentials, or sensitive headers
  may be logged, traced, persisted, or exposed in sanitized errors.

## Public types

```ts
type ModelRetrySetting = boolean | ModelRetryPolicy

interface ModelRetryPolicy {
  maxAttempts?: number              // default 3, includes first attempt
  maxActiveElapsedMs?: number       // default 60_000
  maxActiveDelayMs?: number         // default 20_000
  maxDeferredDelayMs?: number
  respectRetryAfter?: boolean       // default true
  minDelayMs?: number               // default 500
  maxDelayMs?: number               // default 8_000
  retryOn?: {
    network?: boolean               // default true
    timeout?: boolean               // default true
    rateLimit?: boolean             // default true
    serverError?: boolean           // default true
  }
  longRetry?: 'error' | 'defer'     // default error
}

type ModelRetryKind = 'none' | 'active' | 'deferred'

type FinishReason =
  | 'stop'
  | 'length'
  | 'context_limit'
  | 'tool_calls'
  | 'content_filter'
  | 'refusal'
  | 'pause'
  | 'malformed'
  | 'cancelled'
  | 'error'

interface ModelOutcome {
  finishReason: FinishReason
  providerFinishReason?: string
  providerStatus?: string
  retryable?: boolean
  retryKind?: ModelRetryKind
  retryAfterMs?: number
  rateLimit?: ModelRateLimitInfo
  details?: Record<string, JsonValue>
}

interface ModelRateLimitInfo {
  scope?: 'requests' | 'input_tokens' | 'output_tokens' | 'tokens' | 'unknown'
  limit?: number
  remaining?: number
  resetAt?: string
}
```

`TextResponse`, `ObjectResponse`, streamed text finish chunks, and streamed
object finish chunks MUST keep the existing `finishReason` field and MAY include
`outcome`. `finishReason` is the simple path; `outcome` is for operations,
diagnostics, and provider-specific handling.

## Retry resolution

Retry setting precedence:

1. Per-call `call.retry`.
2. Alias defaults `defaults.retry`.
3. Alias top-level `retry`.
4. Default `true`.

`BaseModelProvider` owns harness-managed retry for every provider operation:
`text`, `object`, `embed`, `rerank`, `textStream`, and `objectStream`.
Adapters MUST NOT implement independent retry loops.

Eligible active retry failures:

- network/transport failures normalized as `ModelError{reason:'network'}`
- `OperationTimeoutError{scope:'model'}`
- HTTP 408/409 when normalized as model/network conflict failures
- HTTP 429 / `ModelError{reason:'rate_limited'}`
- HTTP 5xx / `ModelError{reason:'provider_unavailable'}`

Non-retry failures include validation, permissions, unsupported capabilities,
auth/4xx request errors other than 408/409/429, context length errors,
refusal/content-filter outcomes, malformed structured JSON after a provider
success, and stream failures after output has already been yielded.

## Active vs deferred

The harness computes the next retry delay from provider headers when
`respectRetryAfter` is true; otherwise it uses exponential backoff with jitter.

The harness retries actively only when all are true:

- `attempt < maxAttempts`
- failure class is enabled by `retryOn`
- `delayMs <= maxActiveDelayMs`
- `elapsedMs + delayMs <= maxActiveElapsedMs`

If a provider-supplied retry delay exceeds the active budget and is not above
`maxDeferredDelayMs`, the final `ModelError` MUST include:

```ts
{
  reason: 'rate_limited' | 'provider_unavailable' | 'network',
  retryKind: 'deferred',
  retryAfterMs,
  retryAttempt,
  retryMaxAttempts
}
```

If no provider delay exists or the delay exceeds `maxDeferredDelayMs`, the final
error uses `retryKind:'none'`.

## Provider SDK boundary

First-party adapters use official provider SDKs for transport and API mapping,
but the harness owns retry budgets. Therefore:

- OpenAI and Anthropic adapters set SDK `maxRetries: 0` unless the user
  explicitly passes a different SDK option.
- Bedrock sets SDK `maxAttempts: 1` unless the user explicitly passes AWS retry
  options.
- Azure passes official REST client options through; provider retry behavior
  that cannot be disabled remains a transport detail, but final failures still
  normalize through `BaseModelProvider`.

This boundary prevents hidden long sleeps from SDK `Retry-After` handling while
preserving provider SDK support for auth, transport, request typing, and user
escape hatches.

## Provider outcome mapping

Adapters MUST map at least:

| Provider | Raw reason/status | Normalized |
| --- | --- | --- |
| OpenAI Chat / Azure Chat | `stop` | `stop` |
| OpenAI Chat / Azure Chat | `length` | `length` |
| OpenAI Chat / Azure Chat | `tool_calls`, `function_call` | `tool_calls` |
| OpenAI Chat / Azure Chat | `content_filter` | `content_filter` |
| OpenAI Responses | `completed` + function calls | `tool_calls` |
| OpenAI Responses | `completed` | `stop` |
| OpenAI Responses | `incomplete` + `max_output_tokens` | `length` |
| OpenAI Responses | `incomplete` + `content_filter` | `content_filter` |
| Anthropic | `end_turn`, `stop_sequence` | `stop` |
| Anthropic | `max_tokens` | `length` |
| Anthropic | `tool_use` | `tool_calls` |
| Anthropic | `pause_turn` | `pause` |
| Anthropic | `refusal` | `refusal` |
| Anthropic | `model_context_window_exceeded` | `context_limit` |
| Bedrock Converse | `end_turn`, `stop_sequence` | `stop` |
| Bedrock Converse | `max_tokens` | `length` |
| Bedrock Converse | `tool_use` | `tool_calls` |
| Bedrock Converse | `content_filtered`, `guardrail_intervened` | `content_filter` |
| Bedrock Converse | `malformed_model_output`, `malformed_tool_use` | `malformed` |
| Bedrock Converse | `model_context_window_exceeded` | `context_limit` |

Unknown successful provider finish/status values map to `error` and preserve
the raw value in `outcome.providerFinishReason` when available.

## Error and header metadata

Provider error normalization MUST preserve sanitized operational fields:

- `status`
- `providerCode`, `providerType`, `providerParam`, `providerRequestId`,
  `providerMessage`
- content-redacted `providerBody`
- safe `providerHeaders`
- `retryAfterMs`
- `rateLimit`
- `retryKind`, `retryAttempt`, `retryMaxAttempts`

Sensitive headers such as `authorization`, `proxy-authorization`, `api-key`,
`x-api-key`, `openai-api-key`, and `*-api-key` MUST be omitted entirely.

`Retry-After` parsing supports seconds and HTTP dates. `retry-after-ms` is
milliseconds. Rate-limit parsing SHOULD recognize common OpenAI/Azure and
Anthropic request-limit headers.

## Observability

The following privacy-safe metrics/attributes are required:

- `harness.model.retries` counter
- `harness.model.retry.delay` histogram in seconds
- `harness.model.retry.reason`
- model error telemetry attributes for retry kind, retry delay, retry attempt,
  and retry max attempts

No model content or sensitive provider headers may be emitted.

## Acceptance

- Active retry succeeds after a short transient 5xx/429/network failure.
- `retry:false` throws after one attempt.
- Long provider `Retry-After` produces a deferred retry `ModelError` without
  sleeping.
- Streaming retries occur only before the first yielded chunk.
- OpenAI, Anthropic, Bedrock, and Azure adapters map all tabled finish reasons.
- Sanitized errors and telemetry include retry metadata and omit sensitive
  headers/content.
