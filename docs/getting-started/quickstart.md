# Quickstart

This guide creates the smallest useful Harness application: one agent, one
Harness definition, one model binding, and one session call.

## Prerequisites

- Node.js `>=24.15.0`
- npm
- an OpenAI API key for a live run

## Install

Create an empty TypeScript project and install published packages:

```bash
npm install @purista/harness @purista/harness-openai zod
npm install --save-dev typescript
```

The repository example is already configured. Run it with:

```bash
cd examples/quickstart
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. You can also set
`OPENAI_MODEL=gpt-5-mini`.

## Define the agent

An agent is a configurable model loop. Its definition contains schemas,
instructions, and an optional prompt mapper. It contains no API key, live
provider, storage connection, or sandbox.

```ts
import { z } from 'zod'
import { defineAgent } from '@purista/harness'

const assistant = defineAgent('assistant', {
  input: z.object({ topic: z.string() }),
  output: z.object({ answer: z.string() }),
  instructions: 'Return a concise answer matching the output schema.',
  prompt: input => ({ role: 'user', content: `Explain ${input.topic}.` }),
})
```

The schemas validate values at runtime and provide TypeScript types for the
prompt input and final output.

## Compose and start the Harness

```ts
import { defineHarness } from '@purista/harness'
import { openai } from '@purista/harness-openai'

const definition = defineHarness({ name: 'quickstart' }).addAgent(assistant)

const instance = await definition.getInstance({
  model: {
    provider: openai({ apiKey: process.env.OPENAI_API_KEY! }),
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  },
})
```

`defineHarness` compiles immutable definitions and infers the runtime
requirements. Because this graph uses only the default `primary` model alias,
`getInstance` asks for one `model` binding. Adding memory, MCP, durable
execution, or sandbox capabilities makes the corresponding bindings required by
TypeScript.

## Run the agent

```ts
const session = await instance.getSession('quickstart')
const outcome = await session.agents.assistant.run({
  topic: 'enterprise agent harnesses',
})

if (outcome.status === 'completed') {
  console.log(outcome.output.answer)
} else {
  console.log(outcome.interrupt)
}

await instance.close()
```

`run()` returns a terminal outcome. An approval request is an
`interrupted` outcome, so the application can show it to a human and resume
the same run instead of turning it into an HTTP 500 response.

## Stream progress

Use `stream()` when the caller needs live output and status updates:

```ts
for await (const event of session.agents.assistant.stream({
  topic: 'enterprise agent harnesses',
})) {
  if (event.type === 'output.object.snapshot') console.log(event.value)
  if (event.type === 'run.finished') console.log(event.outcome)
}
```

The terminal value represents the same result as `run()`. Browser chat
applications should use `@purista/harness-ai-sdk-ui/v1`, which converts this
stream to AI SDK UI Message Stream v1. Keep persisted run summaries and
operational telemetry in a separate operator view.

## Verify

```bash
npm test
npm run build
npm start
```

The test injects `FakeModelProvider`, so it needs no credential or network
connection.

Continue with [Architecture](../concepts/architecture.md),
[Tools and skills](../guides/tools-and-skills.md), and
[Workflows](../guides/workflows.md).
