# Models

A definition names a model alias; instance configuration binds it to a provider and provider model.

```ts
const classify = defineAgent('classify', {
  model: 'fast', input, output,
  instructions: 'Classify the request.',
  prompt: value => ({ role: 'user', content: value.message }),
})

const instance = await defineHarness({ name: 'routing' }).addAgent(classify).getInstance({
  models: { fast: { provider, model: 'provider-model', retry: true } },
})
```

Declare provider capabilities truthfully. Text, structured output, streaming, embeddings, reranking, image, audio, and video operations remain distinct. Consumer choice between `run` and `stream` does not change the agent's output schema. A provider must implement the streaming operation required by a stream-capable definition.

Keep provider credentials in runtime configuration. Use deterministic fake providers in tests and explicit environment-gated smoke tests for live models.
