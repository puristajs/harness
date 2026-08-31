import { defineHarness, inMemorySandbox } from '@purista/harness'
import { sqliteMemoryEngine } from '@purista/harness-memory-sqlite'

export function createMemoryExample(file = '.purista/memory-example.sqlite') {
  return defineHarness({ name: 'memory-example' })
    .sandbox(inMemorySandbox())
    .memory(sqliteMemoryEngine({ file }))
    .models({ noop: { provider: { id: 'example', genAiSystem: 'example' }, model: 'not-called', capabilities: [] } })
    .build()
}

async function main(): Promise<void> {
  const harness = createMemoryExample()
  const session = await harness.getSession('claim:42', { identity: { tenantId: 'acme', principalId: 'ada' } })
  await session.memory.write('claim-status', { status: 'open' }, { tags: ['claim'], ttlMs: 3_600_000 })
  console.log(await session.memory.read('claim-status'))
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
