# Context projection and bounded compaction

**Status:** human-approved follow-up scope. This specification defines the
opt-in, model-visible context reduction path. It does not change the durable
conversation record.

## Purpose and boundaries

Long tool outputs can exceed a provider context window even though the session
record must remain complete for audit and recovery. The harness SHALL support a
deterministic projection of the next provider request and one bounded retry
after a normalized context-length failure.

This feature is deliberately narrow:

- it operates only on the transient messages sent to a model provider;
- it never rewrites `Message`, `RunRecord`, persisted events, memory, durable
  workspaces, checkpoints, tool results, or user-visible history;
- it does not summarize with a model, issue background work, make network
  calls, or add a scheduler; and
- it does not introduce a new stream transport or change event ordering.

There is no UI configuration path. Applications configure this through the
typed harness defaults or per-call API only.

## Capability inventory

| Capability | Actor / entrypoint | Contract | Failure / recovery | Verification |
|---|---|---|---|---|
| `C-CTX-01` deterministic projection | agent loop prepares a provider request | large eligible tool-result text is reduced in a transient copy | invalid policy rejects before I/O; unavailable budget leaves the original request unchanged | unit and integration tests |
| `C-CTX-02` bounded recovery | provider reports normalized `context_length` | exactly one projected retry is allowed for a run/model call | second context-length failure is returned normally; cancellation wins | integration/failure tests |
| `C-CTX-03` skill safety | a projected request contains activated skills | activated results remain intact, or catalog/path data remains sufficient to reread the skill | no silent loss of skill instructions | invariant tests |

## Policy and deterministic algorithm

`HarnessDefaults.contextProjection`, `ModelAlias.contextProjection`, and
`InvokeOptions.contextProjection` expose the same optional policy. The
effective policy is full replacement with this precedence: explicit invocation,
then selected model alias, then harness default. `undefined` means disabled;
there is no field-by-field merge or implicit narrowing. Builder/model-alias
invalid values throw `HarnessConfigError{reason:'invalid_context_projection'}`;
invalid invocation values throw `ValidationError{where:'invoke_options'}` before
provider I/O. Numeric values are finite non-negative integers measured in UTF-8
bytes.

The initial implementation SHALL support only `toolResultPruner`:

```ts
interface ContextProjectionPolicy {
  readonly toolResultPruner?: {
    readonly maxBytes: number
    readonly headBytes: number
    readonly tailBytes: number
    readonly marker?: string // ASCII-only; default: "...[tool result pruned]..."
  }
}
```

Only the retry request is projected; the first provider call always receives the
normal unprojected history/window. For every eligible tool result whose textual
payload exceeds `maxBytes`, the pruner retains a UTF-8-safe prefix and suffix,
places `"<marker> (N UTF-8 bytes omitted)"` between them, and processes results
in stored message order. The marker is ASCII-only and configuration validation
accounts for its actual UTF-8 byte length plus the complete omission annotation
(including the largest exact JavaScript byte-count representation). It takes at
most `headBytes` from the prefix then at most `tailBytes` from the suffix; the
output is never larger than `maxBytes`, including for a custom marker. It is idempotent:
projecting an already projected request produces the same request. It does not
split UTF-8 code points. Structured non-text payloads are not compacted in this
phase.

The model-visible copy retains the original message order, role, tool-call id,
tool-result id, and every call/result pairing. It records only transient
projection diagnostics (`sourceOrdinal`, original byte count, projected byte
count, and rule id); those diagnostics are not persisted or emitted in content
events.

## Recovery, cancellation, and observability

The model port SHALL normalize a provider context-window rejection to the
existing provider outcome/error taxonomy. On the first such outcome for an
eligible default-loop model call, the loop issues one retry using the projected
copy. It MUST NOT rerun tools, duplicate loop steps, append history, or replay
stream events before that retry. A second context rejection, a non-context
failure, a custom handler, or disabled policy ends through the existing normal
error path.

If cancellation is observed before or during recovery, no retry is issued and
no additional state/event write is made. Timeout and governance behavior remain
unchanged.

This wave emits no projection telemetry. It MAY log the existing normalized
provider error under existing redaction rules, but creates no new span, metric,
or log field. Any future projection telemetry must be listed in
[14-otel-conventions.md](./14-otel-conventions.md).

## Skills and durable-history invariant

Projection follows the skill rule in [08-skills.md](./08-skills.md): it SHALL
preserve activated skill results, or retain the catalog/path information needed
to reread them. The initial tool-result pruner MUST leave activated skill
instructions unchanged. This is tested with a projected request that includes
an activated skill and a large unrelated tool result.

The durable session history and replay/checkpoint inputs remain byte-for-byte
equivalent before and after projection. A caller reading history after a
context-length retry sees the unprojected tool result exactly once.

## Acceptance and non-goals

Acceptance requires tests for UTF-8 boundaries, message/call pairing,
deterministic/idempotent output, invalid policy rejection, precedence,
single-retry recovery, cancellation, no duplicate tool execution, no duplicate
history/events, skill preservation, and redacted diagnostics.

Adaptive token estimation, provider-specific tokenizers, automatic model
summarization, durable history mutation, compaction of arbitrary structured
attachments, and multi-attempt recovery are out of scope. Future strategies
need a new numbered specification and explicit privacy/error/telemetry terms.
