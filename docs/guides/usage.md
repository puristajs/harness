# Use a Harness Instance

Applications call agents and workflows through a session. The model provider,
storage, memory, sandbox, and MCP transports remain behind the Harness instance.

## Create one instance

```ts
const assistant = defineAgent('assistant', {
  input,
  output,
  instructions: 'Answer with verified information.',
  tools: [searchDocs],
})

const definition = defineHarness({ name: 'support' }).addAgent(assistant)
const instance = await definition.getInstance({
  model: { provider, model: 'gpt-5-mini' },
})
```

Create the instance once during service startup. It owns adapter configuration
and shared runtime resources.

## Borrow a session

```ts
const session = await instance.getSession('conversation-42')
try {
  const outcome = await session.agents.assistant.run(input)
  if (outcome.status === 'completed') return outcome.output
  return { approvalRequired: outcome.interrupt }
} finally {
  await session.release()
}
```

Use a stable session id for one conversation or application session.
`release()` returns the borrowed runtime resources while keeping persisted
history. `destroy()` removes the session state.

## Choose aggregate or streaming execution

`run(input, options)` waits for a `completed` or `interrupted` `RunOutcome`.
Failed and cancelled aggregate executions reject with normalized Harness
errors:

```ts
const outcome = await session.agents.assistant.run(input, {
  timeoutMs: 30_000,
  idempotencyKey: 'message-42',
  metadata: { requestId: 'request-42' },
})
```

`stream(input, options)` starts the same target and returns ordered
`ExecutionEvent` values. Its terminal `run.finished` outcome can also be
`failed` or `cancelled`:

```ts
const stream = session.agents.assistant.stream(input)

for await (const event of stream) {
  switch (event.type) {
    case 'output.text.delta':
      process.stdout.write(event.delta)
      break
    case 'approval.requested':
      showApproval(event)
      break
    case 'run.finished':
      storeTerminalOutcome(event.outcome)
      break
  }
}
```

Use `stream.cancel(reason)` when the execution itself must stop. Returning
from the iterator only stops this consumer.

The consumer chooses aggregate or streaming delivery; the agent definition
declares whether progressive output is text deltas or object snapshots.

## Handle interruptions

Approval and external-wait pauses are normal outcomes:

```ts
if (outcome.status === 'interrupted' &&
    outcome.interrupt.type === 'tool-approval') {
  renderApproval(outcome.runId, outcome.interrupt)
}
```

After the application authenticates and authorizes the decision, resume the
same target call with `options.resume` and the durable run identity. Do not
turn an approval request into an exception or generic server error.

For browser chat, use the AI SDK UI adapter:

```ts
import {
  createHarnessUIMessageStreamResponse,
  parseHarnessUIMessageRequest,
} from '@purista/harness-ai-sdk-ui/v1'

const parsed = await parseHarnessUIMessageRequest(await httpRequest.json())
const input = parsed.lastUserMessage.parts
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('')
const targetStream = session.agents.assistant.stream(
  input,
  parsed.resume === undefined ? undefined : { resume: parsed.resume },
)
const events = {
  result: targetStream.result.finally(() => session.release()),
  cancel: (reason?: string) => targetStream.cancel(reason),
  [Symbol.asyncIterator]: () => targetStream[Symbol.asyncIterator](),
}
return createHarnessUIMessageStreamResponse(events, {
  sessionId: parsed.sessionId,
  ...(parsed.assistantMessageId === undefined
    ? {}
    : { messageId: parsed.assistantMessageId }),
})
```

The adapter emits AI SDK UI Message Stream v1 with the standard response
headers. It maps text, status, tool parts, and approval requests without a
PURISTA-specific browser library.

## Call workflows

```ts
const outcome = await session.workflows.reviewIncident.run(input)
```

Agent and workflow invokers have the same `run` and `stream` surface.
Workflows decide which declared agents and models to call internally.

## Inspect session state

```ts
const recent = await session.history.list({ limit: 20 })
const summary = await session.getRunSummary(runId)
const memory = await session.memory.read('customer-preference')
```

History and memory are session-scoped application state. Store business records
in your application database and expose only approved operations through tools.

## Shut down

```ts
await instance.close()
```

Close the instance during service shutdown. It releases instance-owned
adapters, MCP clients, sessions, and background work.
