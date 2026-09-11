# Runtime configuration

`getInstance(...)` accepts the exact bindings inferred from the composed definitions.

```ts
const instance = await definition.getInstance({
  models: {
    chat: {
      provider: openai({ apiKey }),
      model: 'gpt-5-mini',
    },
  },
})
```

Every alias is chosen by application definitions. Harness reserves no alias and
has no singular runtime shortcut. Bind the exact projected aliases and
infrastructure requirements:

```ts
const advancedInstance = await advancedDefinition.getInstance({
  models: {
    chat: { provider: openai({ apiKey }), model: 'gpt-5-mini', retry: true },
    embeddings: { provider, model: 'text-embedding-3-small' },
  },
  storage,
  memory,
  sandbox,
  workspace,
  mcp: { knowledge: { transport: 'http', url: 'https://mcp.internal.example' } },
  logger: new JsonLogger({ level: 'info' }),
  telemetry: { flavor: 'dual', contentCaptureMode: 'NO_CONTENT' },
})
```

Omit bindings the graph does not require. Extra, missing, malformed, or capability-incompatible bindings fail before a session or effect is created. The application owns adapter lifecycle unless the adapter contract explicitly says the Harness owns it.

Harness defaults belong in `defineHarness({ name, revision, defaults })`. They describe execution policy such as bounded context projection, history retention, or call ceilings; they do not contain credentials or clients.
