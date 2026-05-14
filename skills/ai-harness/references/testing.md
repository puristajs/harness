# Testing

## Contents
- Default Checks
- Fake Model Providers
- Type Tests
- Contract Tests
- Streaming Tests
- Adapter Failure Tests

## Default Checks
For the harness repo, run the narrowest relevant checks first, then the package-level gates:

```bash
npm run lint
npm run typecheck
npm test
npm run test:contracts
npm run test:integration
npm run test:failure
npm run build
```

If a package script differs, inspect `package.json` and use the local script names.

## Fake Model Providers
Unit and integration tests should not require live provider credentials. Inject a fake `ModelProvider`:

```ts
import type { JsonValue, ModelProvider, ObjectRequest, ObjectResponse } from '@purista/harness'

class FakeObjectProvider implements ModelProvider {
  readonly id = 'fake'
  readonly genAiSystem = 'fake'

  async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return {
      object: { answer: 'fake answer' } as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop'
    }
  }
}
```

Use fake providers for:
- agent input/output validation
- workflow orchestration
- tool call loops
- permissions
- streaming event shape
- telemetry/logging behavior

Keep one explicit live-provider smoke test path if needed, gated by env vars such as `OPENAI_API_KEY`.

## Type Tests
Add type tests for builder inference:
- unknown model aliases are rejected in agents
- unknown tools/skills are rejected in agents
- workflow `ctx.agents.<id>` input/output types come from the agent schemas
- model handles expose only declared capability methods
- multimodal content parts require matching input capabilities
- `embed` and `rerank` exist only on matching aliases

Use `@ts-expect-error` for negative cases.

## Contract Tests
Use `@purista/harness/testing` for reusable adapter contracts when available:
- `FakeModelProvider`
- `FakeMemoryAdapter`
- `makeHarness`
- `stateStoreContract`
- `memoryAdapterContract`
- `sandboxContract`
- `sandboxSnapshotContract`
- `fakeSnapshotSandbox`
- `adapterCapabilitiesContract`
- `fakeCapabilityAdapter`
- `createInMemoryFeedbackRecorder`

Adapters should prove cancellation, timeout, validation failure, and shutdown behavior.

`FakeModelProvider` supports queued text/object/embedding/rerank responses and queued text/object stream chunks:

```ts
const model = new FakeModelProvider()
model.enqueueObject({
  object: { answer: 'ok' },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: 'stop'
})
model.enqueueEmbedding({
  embeddings: [{ index: 0, vector: [0.1, 0.2] }],
  usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 }
})
```

## Streaming Tests
Collect stream events and assert lifecycle behavior:

```ts
const events = []
for await (const event of session.workflows.audit.stream({ scope: 'all' })) {
  events.push(event)
}

expect(events.some((event) => event.type === 'run.started')).toBe(true)
expect(events.some((event) => event.type === 'run.finished')).toBe(true)
```

Test stream consumers against `RunEvent`, not provider-specific HTTP/SSE chunks. HTTP/SSE mapping belongs to the application integration layer.

## Adapter Failure Tests
Provider adapters should cover:
- provider 4xx and 5xx mapping
- rate-limit/network retry metadata
- context-length exceeded as non-retriable
- malformed provider responses
- missing provider operation for a declared capability
- cancellation through `AbortSignal`
- model/tool/schema validation failures

State, memory, and sandbox adapters should cover:
- stable ordering
- idempotent close/shutdown
- append atomicity where required
- missing sessions/files/runs
- executor unavailable behavior
- snapshot/resume behavior when implemented
- scope isolation, unsupported capability gates, and content-capture behavior for memory adapters
