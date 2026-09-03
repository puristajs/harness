# CTR-DB-CONTINUATION: exact provider mapping

## Public API Inventory

Replace ProviderItems with this provider-neutral closed envelope in `packages/harness/src/ports/model-provider.ts`:

```ts
interface ProviderContinuation {
  readonly providerId: string
  readonly items: readonly ProviderContinuationItem[]
}
type ProviderContinuationItem =
  | { readonly kind: 'opaque'; readonly data: JsonValue }
  | { readonly kind: 'tool_call'; readonly callId: string; readonly data?: JsonValue }
  | { readonly kind: 'assistant_content' }
```

Use the property `providerContinuation` on assistant ModelMessage, ObjectResponse, TextResponse, and finish chunks that currently carry providerItems. Keep ToolCallSpec as the sole public tool-call envelope. Runtime validation uses the canonical JSON leaf validator and exact discriminants; unknown fields are rejected. `providerId` uses the bounded configuration identifier rule and is compared with the owning adapter’s existing declared identifier; no registry is added. Empty items always mean ordinary canonical reconstruction, including messages with canonical tool calls.

## Mapping and validation

The provider adapter owns the template and its opaque JSON. A same-provider nonempty template references every canonical tool call exactly once, with no duplicate/unknown IDs, and contains at most one assistant_content slot. It never carries a duplicate ordinary function-call envelope or ordinary assistant message in opaque data. Tool-call data contains provider routing/item identity only, no name or arguments. Core validates the neutral shape/references; each adapter validates its own data before request construction. Malformed templates fail with non-retriable `ModelError` and reason `invalid_provider_continuation` before provider I/O. A mismatched providerId is ignored and the adapter reconstructs ordinary canonical content/tool calls; this is provider-switch behavior, not an old-API compatibility path.

OpenAI mapping: response output reasoning items become opaque entries, unchanged and in original order. Function-call items become tool_call slots whose optional data is the strict object `{itemId?: string}`. Multiple message items collapse to one assistant_content slot at the position of the first message item, preserving relative order of remaining opaque/call entries; their original text is not retained in the template. On request construction, each tool slot is resolved from the current canonical call ID/name/arguments, preserving itemId when supplied. Populate content from the current canonical assistant message (empty on intermediate tool turns); omit its slot when content is empty. No response.output array is replayed wholesale. Unknown response output items cannot silently enter opaque data; reject unsupported continuation item types with the same safe ModelError.

Anthropic, Bedrock, and Azure Foundry currently reconstruct provider-neutral tool messages. They continue to use canonical calls; no invented opaque template is required. Azure's OpenAI-backed path must forward through the updated OpenAI adapter when that is its implementation. Streaming and non-streaming responses carry the same template semantics. Model registry/state/recording fakes must propagate the new field without serializing it into durable messages or operational events.

Opaque provider-required reasoning can contain signed/encrypted or provider-authored reasoning. Its transient replay is not a promise that text masking removes content embedded in opaque reasoning. Do not decode, redact, hash into metrics, persist, or log it. Applications requiring no opaque continuation can select a provider/model mode that does not require it; this work introduces no fallback that drops required reasoning and retries a broken request.

## Verification

Extend OpenAI adapter wire tests using synthetic reasoning: original tool memo replaced by input rail; next request retains required reasoning and only transformed canonical arguments. Verify ordering, multiple-message collapse, empty templates with tool calls, empty content slots, invalid references, duplicate slots, foreign provider selection, streaming parity, and missing original arguments in persisted transcript. Run all four provider suites and existing replay/public-export tests. Direct ctx.models calls remain outside automatic rails; this change does not pretend otherwise.
