# Package surface

Import public contracts from package entry points only:

```ts
import { defineAgent, defineHarness, defineTool, defineWorkflow } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import {
  AI_SDK_UI_MESSAGE_STREAM_V1_PROTOCOL,
  createHarnessUIMessageStreamResponse,
  pipeHarnessUIMessageStream,
} from '@purista/harness-ai-sdk-ui/v1'
```

First-party packages provide model providers, memory engines, durable storage, sandbox adapters, guardrails, OPA policy evaluation, AI SDK UI projection, and Agent Plugin inspection. Do not import sibling source files or private `dist` paths. Add only the packages used by the application and use normal published package ranges in examples.

Use `createHarnessUIMessageStreamResponse(...)` when the adapter owns the HTTP
response. When a host framework owns streaming, identify the endpoint with
`AI_SDK_UI_MESSAGE_STREAM_V1_PROTOCOL` and use
`pipeHarnessUIMessageStream(events, writer, request)`. The pipe helper owns
projection, completion, closing, and upstream cancellation; the host derives
the protocol headers or applies the exported header map at its HTTP boundary.
