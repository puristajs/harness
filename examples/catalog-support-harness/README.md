# Catalog Support Harness

This runnable example shows how immutable catalogs group reusable definitions while the application owns its workflows and runtime adapters.

## Run it

```bash
npm install
npm run test
OPENAI_API_KEY=... npm run start
```

Set `OPENAI_MODEL` to override `gpt-5-mini`. Tests inject a deterministic provider, so they require no network or credential.

## What it teaches

- `defineAgent(...)` creates the reusable support agent.
- `defineCatalog(...)` groups the agent without binding a provider or other runtime resource.
- `defineWorkflow(...)` keeps application orchestration next to the business use case.
- `defineHarness(...).use(catalog).addWorkflow(workflow)` composes both definition sets and rejects duplicate ids.
- `getInstance(...)` supplies the model and logger when the application starts.
- Replay fixtures are sanitized before storage and consumed by a no-network provider in tests.

Use a catalog when several Harnesses share trusted definitions. Keep tenant configuration, adapters, credentials, and mutable state in the application runtime.
