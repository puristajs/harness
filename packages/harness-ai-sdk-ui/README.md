# @purista/harness-ai-sdk-ui

AI SDK UI Message Stream v1 adapter for `@purista/harness`. It projects a v4
Harness target stream to the protocol consumed by AI SDK `useChat` and AI
Elements, without a PURISTA-specific browser library.

## Install

```bash
npm install @purista/harness @purista/harness-ai-sdk-ui ai
```

The package supports AI SDK 7 and verifies its protocol behavior against
`ai@7.0.90`.

## Handle a chat request

Use `parseHarnessUIMessageRequest` at the HTTP boundary. It asynchronously
validates the standard `DefaultChatTransport` body with AI SDK
`validateUIMessages`. Your application remains responsible for mapping the
validated user message to the selected agent's input contract.

```ts
import {
  createHarnessUIMessageStreamResponse,
  parseHarnessUIMessageRequest,
} from '@purista/harness-ai-sdk-ui/v1'

async function handleChat(request: Request) {
  const parsed = await parseHarnessUIMessageRequest(await request.json(), {
    sessionId: authenticatedSessionId,
  })
  const session = await instance.getSession(parsed.sessionId)

  const input = parsed.lastUserMessage.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')

  const targetStream = parsed.resume === undefined
    ? session.agents.support.stream(input)
    : session.agents.support.resume(parsed.resume).stream()

  return createHarnessUIMessageStreamResponse(targetStream, {
    request: parsed,
    onSettled: () => session.release(),
  })
}
```

`instance` above is the v4 standalone Harness instance returned by the
compiled definition's `getInstance(...)`. A structured agent should replace
the text mapping with application-owned validation and mapping for its domain
input. Approval continuation restores the original validated target input from
durable Harness state; the browser does not resend it.

The response has HTTP status 200 for an approval interruption and uses the
standard `x-vercel-ai-ui-message-stream: v1` header and SSE framing. Text,
files, tools, approval requests, errors, aborts, and step boundaries are
standard AI SDK chunks. Harness lifecycle and structured output use typed
`data-status` and `data-output` parts.

`parseHarnessUIMessageRequest` also validates approval correlation. It returns
the last assistant id for approval continuation and for
`regenerate-message`, allowing the replacement stream to preserve that
message identity.

## Use a host-owned SSE writer

When a framework owns the HTTP response, use the data-only helper. Pass the
same stable Harness session id required by the full Response helper.

```ts
import {
  pipeHarnessUIMessageStream,
} from '@purista/harness-ai-sdk-ui/v1'

await pipeHarnessUIMessageStream(events, streamWriter, parsed)
```

`streamWriter` only needs `cancelled`, `write`, `close`, and `onCancel`; a
framework stream writer can implement that interface without depending on
Harness. The pipe helper projects and forwards data-only records, writes
`[DONE]`, closes a successful stream, and propagates consumer cancellation.

`AI_SDK_UI_MESSAGE_STREAM_V1_PROTOCOL` lets a framework host recognize the
protocol and select the standard headers automatically. For a lower-level HTTP
integration, apply `AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS` to the response. The
host owns the `data:` prefix and SSE record separators.

If the browser or HTTP consumer disconnects, the response, pipe, and data-only helpers call
`HarnessTargetStream.cancel(reason?)`, which requests cancellation of target
execution. Returning from the async iterator only stops local observation.

## Tool approval behavior

The browser answers standard approval requests through AI SDK
`addToolApprovalResponse({ id, approved, reason? })`. The next transport body
contains the updated assistant message; `parseHarnessUIMessageRequest`
reconstructs the correlated, revisioned `ToolApprovalResume` shown in the
first example.

Live streams use their existing standard dynamic tool input parts. A terminal
approval receipt replay contains only root start and finish events, so the
adapter reconstructs a missing standard tool input part from the approval
request before emitting `tool-approval-request`. Both paths are accepted by
the official AI SDK UI message reader without duplicating live tool input.

## Protocol versions

The package root currently re-exports v1. Import
`@purista/harness-ai-sdk-ui/v1` when the protocol version should be explicit.
Future versions can use separate entry points.
