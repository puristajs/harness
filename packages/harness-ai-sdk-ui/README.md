# @purista/harness-ai-sdk-ui

AI SDK UI Message Stream v1 adapter for `@purista/harness`. It lets a native
Harness agent or workflow stream directly to AI SDK `useChat` and AI Elements
without a PURISTA-specific browser library.

## Install

```bash
npm install @purista/harness @purista/harness-ai-sdk-ui ai
```

## Stream a run

```ts
import { createHarnessUIMessageStreamResponse } from '@purista/harness-ai-sdk-ui'

const session = await harness.getSession(sessionId)
const events = session.agents.support.stream(input)

return createHarnessUIMessageStreamResponse(events)
```

The response uses the standard `x-vercel-ai-ui-message-stream: v1` header and
SSE data format. Text and tools are standard AI SDK message parts. Harness
status and structured output are typed `data-status` and `data-output` parts.

When a framework owns the HTTP response, use
`createHarnessUIMessageSseEvents(events)` and write each returned data-only SSE
event through that framework's native stream. Apply the exported
`AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS` to the endpoint response.

## Resume tool approval

The browser uses AI SDK `addToolApprovalResponse`. On the next request, parse
the resulting assistant message and pass the resume to the same Harness run:

```ts
import {
  createHarnessUIMessageStreamResponse,
  parseHarnessToolApprovalResume,
} from '@purista/harness-ai-sdk-ui'

const { messages } = await request.json()
const resume = parseHarnessToolApprovalResume(messages)
const lastAssistant = messages.findLast(message => message.role === 'assistant')

const events = session.agents.support.stream(input, resume ? { resume } : undefined)

return createHarnessUIMessageStreamResponse(events, {
  messageId: lastAssistant?.id,
})
```

An approval interruption is a successful stream outcome. The adapter emits
standard `tool-approval-request` and `tool-approval-response` chunks, so a UI
can ask a human to approve or reject without interpreting an HTTP 500.

## Protocol versions

The package root currently exports v1. Applications that want an explicit
wire contract can import `@purista/harness-ai-sdk-ui/v1`. Future protocol
versions can be added as separate entry points.
