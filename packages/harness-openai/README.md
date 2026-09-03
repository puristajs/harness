# @purista/harness-openai

OpenAI model provider adapter for `@purista/harness`.

## Install

```bash
npm install @purista/harness @purista/harness-openai
```

Configure the provider with an OpenAI API key in your application environment.
The adapter is designed for use through the typed `@purista/harness` model
provider port.

```ts
import { openai } from '@purista/harness-openai'

const provider = openai({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL
})
```

## OpenAI-compatible endpoints

By default, generation uses Chat Completions. That is the intended path for
OpenAI-compatible providers and self-hosted endpoints; do not create a second
adapter merely to change the endpoint. Supply that provider's base URL, API
key, and model id:

```ts
const provider = openai({
  apiKey: process.env.COMPATIBLE_API_KEY!,
  baseURL: process.env.COMPATIBLE_BASE_URL!,
  api: 'chat_completions', // optional: this is the default
})
```

The target must implement the OpenAI Chat Completions request/stream format for
the operations you enable. Declare only the capabilities that the particular
endpoint and model support, and use an offline adapter test plus an opt-in
credential-gated smoke test before enabling tools, JSON-schema object output,
vision, or embeddings in production.

`api: 'responses'` is for the OpenAI Responses API, not a generic
OpenAI-compatible escape hatch. Many compatible servers expose only Chat
Completions.

Use the Responses API for OpenAI reasoning models that require function tools
and reasoning effort on `/v1/responses`, such as `gpt-5.5`:

```ts
openai({
  apiKey: process.env.OPENAI_API_KEY!,
  api: 'responses'
})
```

When Chat Completions is used with tools and `providerOptions.reasoning_effort`,
the adapter drops `reasoning_effort` and emits a warning instead of sending a
request that OpenAI rejects. Use `api: 'responses'` when you need reasoning
effort and tool calls together.

## Generation settings

Configure portable generation values on the Harness model alias, not in the
factory. `maxTokens` maps to `max_tokens` for Chat Completions by default and
to `max_output_tokens` for Responses. If a native OpenAI Chat Completions model
requires the newer field, set
`chatCompletionMaxTokensParameter: 'max_completion_tokens'` on `openai(...)`.
Keep the default for an OpenAI-compatible endpoint unless it documents the
newer field.

Responses does not support stop sequences. The adapter rejects a configured
Harness `stopSequences` setting in `api: 'responses'` mode instead of silently
discarding it. `temperature` and `topP` are forwarded only when set, but some
reasoning models reject sampling controls; leave them unset unless the exact
model/API reference supports them. Put a provider-specific request-body field
in `defaults.providerOptions` (or per-call `call.providerOptions`) and SDK
transport options in `providerOptions.requestOptions`.

On the Responses API, tool-call responses carry a canonical
`providerContinuation`. The harness agent loop retains provider-required
reasoning transiently, then reconstructs the follow-up request from current
canonical tool calls and arguments. For stateless requests (`store: false`), additionally set
`providerOptions: { store: false, include: ['reasoning.encrypted_content'] }`
so the encrypted reasoning content rides along in the replayed items.

Opaque reasoning is transient provider state, not text that content rails can
inspect or rewrite. Tool-call slots are rebuilt from canonical transformed
arguments; no raw argument copy is an alternate source of truth. Attached
guardrails protect default-loop agents, not direct `ctx.models.*` calls.
Successful model invocations emit `model.completed` for accounting even when
a later content decision blocks delivery. See the
[decision boundary guide](../../docs/guides/decisions-and-approval.md).

## Package Format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`. Source files, tests, source maps, and local configs
are not included in the published package.
