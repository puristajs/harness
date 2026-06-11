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

By default, generation uses Chat Completions for compatibility with
OpenAI-compatible endpoints:

```ts
openai({ apiKey: process.env.OPENAI_API_KEY! })
```

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

On the Responses API, tool-call responses carry the turn's raw output items
(including reasoning items) as `providerItems`. The harness agent loop passes
them back on the follow-up round and the adapter echoes them verbatim, as
OpenAI recommends for reasoning models with manually managed conversation
state. For stateless requests (`store: false`), additionally set
`providerOptions: { store: false, include: ['reasoning.encrypted_content'] }`
so the encrypted reasoning content rides along in the replayed items.

## Package Format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`. Source files, tests, source maps, and local configs
are not included in the published package.
