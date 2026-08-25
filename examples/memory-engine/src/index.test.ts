import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createMemoryExample } from './index.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('persists a session-scoped fact through SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'purista-memory-example-')); roots.push(root)
  const harness = createMemoryExample(join(root, 'memory.sqlite'))
  const session = await harness.getSession('claim:42', { tenantId: 'acme' })
  await session.memory.write('status', 'open')
  await expect(session.memory.read('status')).resolves.toBe('open')
  await harness.shutdown()
})
