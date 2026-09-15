# Conversation History

History belongs to a Harness session. Agents in the same session can use the
same validated conversation context without receiving a storage adapter
directly.

## Read history

```ts
const session = await instance.getSession('conversation-42')
try {
  const page = await session.history.list({ limit: 20 })
  console.log(page.items)
} finally {
  await session.release()
}
```

Agent runs append model-visible messages only after the runtime validates and
commits them. Failed or cancelled runs do not silently become successful
history.

## Bound model context

Pass `historyWindow` when one call should use only the most recent messages:

```ts
await session.agents.assistant.run(input, { historyWindow: 12 })
```

Context projection can also prune oversized tool results for a retry. It does
not rewrite durable audit history.

## Replace or clear history

```ts
await session.replaceHistory([
  { role: 'user', content: 'Start from this verified summary.' },
])

await session.clearHistory()
```

These operations change conversation context. Protect them at the application
boundary and keep tenant and principal authorization separate from the session
id.

## Memory is different

`session.memory` stores session-like application state and retrieval entries.
History stores the conversation message sequence. Business entities such as
orders, payments, and transactions belong in a database resource behind a
typed tool.
