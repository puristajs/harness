# Package surface

Import public contracts from package entry points only:

```ts
import { defineAgent, defineHarness, defineTool, defineWorkflow } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { createHarnessUIMessageStreamResponse } from '@purista/harness-ai-sdk-ui/v1'
```

First-party packages provide model providers, memory engines, durable storage, sandbox adapters, guardrails, OPA policy evaluation, AI SDK UI projection, and Agent Plugin inspection. Do not import sibling source files or private `dist` paths. Add only the packages used by the application and use normal published package ranges in examples.
