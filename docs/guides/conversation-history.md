# Conversation History, Storage Bounds, and Retries

Harness keeps durable history and model context separate. This distinction is
important: a model's context window is measured in tokens, while persistence is
an operational storage concern.

## Bound durable history by complete turns

Use `defaults.historyRetention` when a session must not accumulate history
indefinitely. The policy retains the newest complete turns and counts the UTF-8
bytes of the persisted messages. A turn includes its user input, every
assistant/tool exchange, and the terminal assistant output; the Harness never
keeps a partial tool exchange merely to fit a limit.

```ts
import { defineHarness, InMemoryHarnessStorage } from '@purista/harness'

const harness = defineHarness({ name: 'support' })
	.storage(new InMemoryHarnessStorage())
	.defaults({
		historyRetention: { maxTurns: 50, maxBytes: 256_000 },
	})
	// models, tools, and agents
	.build()
```

`historyRetention` requires a Harness storage that implements atomic
`replaceMessages`. The Harness fails at build time instead of falling back to a
non-atomic read/trim/write sequence. If the newest complete turn alone exceeds
`maxBytes`, the call fails rather than persisting an invalid partial history.

The byte bound is deliberately **not** a token estimate. Use a model/provider
token counter and its declared context window when choosing which retained
messages fit a particular request. Such selection is transient and must not
delete durable history. `historyWindow` remains a simple message-count request
limit when that is sufficient.

## Retry-safe direct agent delivery

For an at-least-once transport, supply a stable delivery key to a direct agent
call. It must be owned by the caller—for example, a queue message id—not derived
from prompt text.

```ts
const session = await harness.getSession(`customer:${customerId}`)
const output = await session.agents.support.run(input, {
	idempotencyKey: message.id,
})
```

The key is scoped to this session and agent. Reuse the transport delivery id
for a retry of the same message; another conversation may safely use the same
delivery id without sharing a replay record.

When the same session, agent, key, and input are delivered again after a
successful run, Harness returns the recorded output without another provider
call or another transcript write. Provider retries before a successful turn
commit also leave no partial transcript. This does not make external tool or
service side effects exactly-once: design those operations with their own
idempotency contracts.

For workflows, use the existing Harness storage/workspace idempotency contract;
the direct-agent `idempotencyKey` is intentionally not inferred for a workflow
because workflow inputs and side effects need an explicit durable policy.
