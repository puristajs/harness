# @purista/harness-google

Google Gemini API model provider adapter for `@purista/harness`.

## Install

```bash
npm install @purista/harness @purista/harness-google
```

## Gemini API

Create the provider with an API key from Google AI Studio and bind only the
capabilities supported by your selected Gemini model:

```ts
import { google } from '@purista/harness-google'

const provider = google({ apiKey: process.env.GEMINI_API_KEY! })
```

```ts
const instance = await definition.getInstance({
  models: {
    assistant: {
      provider,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    },
    embeddings: {
      provider,
      model: process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-2',
    },
  },
})
```

The adapter maps text, structured object generation, streaming, application
function tools, tool results, embeddings, and inline image/audio/file data to
the official `@google/genai` SDK. It does not provide reranking.

`apiKey`, Vertex/enterprise settings, `httpOptions`, and the remaining
official `GoogleGenAIOptions` are accepted by `google(...)`. The adapter uses
one client-side message history per Harness request, so Harness storage remains
the source of conversation state.

For remote file URLs, the Gemini API accepts only URI schemes and storage
locations supported by the selected Google API/model. Prefer inline data for
small application-owned content or upload files through application code before
passing a URI; the adapter never uploads local sandbox files automatically.

## Package format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`.
