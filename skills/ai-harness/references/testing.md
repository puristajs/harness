# Testing

Use `@purista/harness/testing` and application-owned fakes. A useful test composes the real definitions and creates a real instance with fake adapters:

```ts
const provider = new FakeModelProvider({ strict: true })
provider.enqueueObject({
  object: { answer: 'ok' }, finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})
const instance = await definition.getInstance({ model: { provider, model: 'fake' } })
const session = await instance.getSession('test')
await expect(session.agents.assistant.run(input)).resolves.toMatchObject({ status: 'completed' })
provider.assertExhausted()
await instance.close()
```

Test definition inference with positive assignments and `@ts-expect-error` negatives. Use public adapter contract suites for storage, memory, sandbox, workspace, and text search. Test cancellation, timeouts, malformed output, capability mismatch, cleanup, privacy, and deterministic replay.

For browser endpoints, feed `stream(...)` to `@purista/harness-ai-sdk-ui/v1` and assert official AI SDK UI Message Stream v1 headers and parsing. Test approval continuation and disconnect cancellation. Keep live-provider and live-infrastructure tests opt-in through environment variables.
