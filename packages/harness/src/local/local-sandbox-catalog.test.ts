import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SandboxStateLostError } from '../errors/index.js'
import { LocalSandboxCatalog } from './local-sandbox-catalog.js'

const owner = { namespace: 'example', id: 'owner', instanceId: '01J00000000000000000000000' } as const
const scope = { owner, partition: { kind: 'shared' as const }, lifetime: 'session' as const }

describe('LocalSandboxCatalog', () => {
  it('recovers only its durable journal and reports state loss when a known journal is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-local-catalog-'))
    try {
      const first = new LocalSandboxCatalog({ root })
      await first.registerOwner({ owner, mode: 'create' })
      await first.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner, scope })
      const recovered = new LocalSandboxCatalog({ root })
      await expect(recovered.list({ selector: { kind: 'owner', owner } })).resolves.toMatchObject({ items: [{ resourceId: 'sandbox-one' }] })

      await unlink(join(root, 'sandbox-catalog', 'catalog.json'))
      const missing = new LocalSandboxCatalog({ root })
      await expect(missing.list({ selector: { kind: 'owner', owner } })).rejects.toBeInstanceOf(SandboxStateLostError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes two catalog clients sharing a durable authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-local-catalog-'))
    try {
      const other = { namespace: 'example', id: 'other', instanceId: '01J00000000000000000000001' } as const
      const first = new LocalSandboxCatalog({ root })
      const second = new LocalSandboxCatalog({ root })
      await Promise.all([first.registerOwner({ owner, mode: 'create' }), second.registerOwner({ owner: other, mode: 'create' })])
      await expect(first.list({ selector: { kind: 'owner', owner } })).resolves.toMatchObject({ items: [] })
      await expect(second.list({ selector: { kind: 'owner', owner: other } })).resolves.toMatchObject({ items: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
