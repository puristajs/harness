import { describe, expect, it } from 'vitest'

import { OperationCancelledError, OperationTimeoutError, SandboxNoExecutorError, SandboxPermissionDeniedError, SandboxStateLostError } from '../errors/index.js'
import { isExecCapableSession, isTextSearchCapableSession, type Sandbox, type SandboxScope, type SandboxSessionBase } from '../sandbox/index.js'

const CONTRACT_INSTANCE = '01J00000000000000000000000'

function requireExecutor(session: SandboxSessionBase) {
  if (!isExecCapableSession(session)) throw new Error('Adapter advertises an executor but does not expose exec.')
  return session
}

function contractScope(id = 's1', runId = 'r1', identity?: { tenantId?: string; principalId?: string }): SandboxScope {
  return {
    owner: { namespace: 'sandbox-contract', id, instanceId: CONTRACT_INSTANCE, ...(identity ? { identity } : {}) },
    partition: { kind: 'shared' },
    lifetime: 'run', runId
  }
}

function actor(scope: SandboxScope) { return scope.owner.identity ? { identity: scope.owner.identity } : {} }

async function open(sandbox: Sandbox, scope: SandboxScope, mode: 'create' | 'attach' | 'restore' = 'create') {
  await sandbox.registerOwner({ owner: scope.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return await sandbox.open({ scope, mode, ...actor(scope) })
}

async function openContractSession(sandbox: Sandbox): Promise<Awaited<ReturnType<Sandbox['open']>>['session']> {
  return (await open(sandbox, contractScope())).session
}

/** Shared behavioural checks for each concrete Sandbox adapter. */
export function sandboxContract(make: () => Sandbox | Promise<Sandbox>, opts: { executor: 'available' | 'unavailable' }): void {
  describe(`sandboxContract (${opts.executor})`, () => {
    it('exposes owner registration and bounded administration', async () => {
      const sandbox = await make()
      const scope = contractScope('catalog')
      await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
      expect((await sandbox.administration.list({ selector: { kind: 'owner', owner: scope.owner }, limit: 10 })).items).toEqual([])
    })

    it('opens only after metadata registration and reports expected executor', async () => {
      const sandbox = await make()
      const scope = contractScope()
      await expect(sandbox.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
      expect((await openContractSession(sandbox)).executor).toBe(opts.executor)
    })

    it('attaches a second client without replacing logical files', async () => {
      const sandbox = await make()
      const scope = contractScope()
      const first = (await open(sandbox, scope)).session
      await first.write('/workspace/retained.txt', 'retained')
      const second = (await open(sandbox, scope, 'attach')).session
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')
      await first.close()
      await expect(first.readText('/workspace/retained.txt')).rejects.toThrow()
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')
    })

    it('coalesces concurrent creates without replacing state', async () => {
      const sandbox = await make()
      const scope = contractScope('create-retry')
      await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
      const [first, second] = await Promise.all([sandbox.open({ scope, mode: 'create' }), sandbox.open({ scope, mode: 'create' })])
      expect([first.disposition, second.disposition].sort()).toEqual(['attached', 'created'])
      await first.session.write('/workspace/retained.txt', 'retained')
      await expect(second.session.readText('/workspace/retained.txt')).resolves.toBe('retained')
    })

    it('never creates absent attach or restore state', async () => {
      const sandbox = await make()
      const scope = contractScope('missing', 'missing')
      await expect(sandbox.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(sandbox.open({ scope, mode: 'restore' })).rejects.toBeInstanceOf(SandboxStateLostError)
    })

    it('does not replace an active scope when restore is unsupported', async () => {
      const sandbox = await make()
      const scope = contractScope('unsupported-restore')
      const { session } = await open(sandbox, scope)
      await session.write('/workspace/retained.txt', 'retained')
      await expect(open(sandbox, scope, 'restore')).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(session.readText('/workspace/retained.txt')).resolves.toBe('retained')
    })

    it('terminates idempotently and rejects every old open mode', async () => {
      const sandbox = await make()
      const scope = contractScope('terminated', 'terminated')
      const first = (await open(sandbox, scope)).session
      const second = (await open(sandbox, scope, 'attach')).session
      await sandbox.terminate({ scope, reason: 'run_disposed' })
      await sandbox.terminate({ scope, reason: 'run_disposed' })
      for (const mode of ['create', 'attach', 'restore'] as const) await expect(open(sandbox, scope, mode)).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(first.readText('/workspace/retained.txt')).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(second.write('/workspace/stale.txt', 'stale')).rejects.toBeInstanceOf(SandboxStateLostError)
    })

    it('retains a tombstone when termination precedes creation', async () => {
      const sandbox = await make()
      const scope = contractScope('never-created')
      await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
      await sandbox.terminate({ scope, reason: 'manual' })
      await expect(open(sandbox, scope)).rejects.toBeInstanceOf(SandboxStateLostError)
    })

    it('keeps owner incarnation, partition, run, and identity exact', async () => {
      const sandbox = await make()
      const base = contractScope('identity')
      const scopes: SandboxScope[] = [
        base, contractScope('identity', 'r1', {}), contractScope('identity', 'r1', { tenantId: 'tenant' }),
        contractScope('identity', 'r1', { principalId: 'principal' }), contractScope('identity', 'r1', { tenantId: 'tenant', principalId: 'principal' }),
        { ...base, owner: { ...base.owner, namespace: 'another-harness' } },
        { ...base, owner: { ...base.owner, instanceId: '01J00000000000000000000001' } },
        ({ owner: base.owner, partition: { kind: 'group', id: 'team' }, lifetime: 'run', runId: 'r1' } as unknown as SandboxScope), ({ owner: base.owner, partition: { kind: 'shared' }, lifetime: 'run', runId: 'another-run' } as unknown as SandboxScope),
        { owner: base.owner, partition: { kind: 'shared' }, lifetime: 'session' }
      ]
      for (const [index, scope] of scopes.entries()) {
        const { session } = await open(sandbox, scope)
        await session.write('/workspace/identity.txt', String(index))
      }
      for (const [index, scope] of scopes.entries()) {
        const { session } = await open(sandbox, scope, 'attach')
        await expect(session.readText('/workspace/identity.txt')).resolves.toBe(String(index))
      }
      const reordered = await open(sandbox, contractScope('identity', 'r1', { principalId: 'principal', tenantId: 'tenant' }), 'attach')
      await expect(reordered.session.readText('/workspace/identity.txt')).resolves.toBe('4')
    })

    it('rejects malformed scope requests before state mutation', async () => {
      const sandbox = await make()
      const base = contractScope('invalid-scope')
      const invalid = [
        { ...base, owner: { ...base.owner, id: '' } }, { ...base, owner: { ...base.owner, instanceId: '' } },
        { ...base, lifetime: 'session', runId: 'unexpected' } as unknown as SandboxScope, { ...base, runId: '' }, { ...base, partition: { kind: 'group', id: '' } },
        { ...base, owner: { ...base.owner, identity: { tenantId: undefined } } }, { ...base, unexpected: 'value' }
      ]
      for (const scope of invalid) {
        await expect(sandbox.open({ scope: scope as unknown as SandboxScope, mode: 'create' })).rejects.toThrow()
        await expect(sandbox.terminate({ scope: scope as unknown as SandboxScope, reason: 'manual' })).rejects.toThrow()
      }
      await expect(open(sandbox, base)).resolves.toMatchObject({ disposition: 'created' })
    })

    it('honours pre-aborted lifecycle requests without mutation', async () => {
      const sandbox = await make()
      const scope = contractScope('cancelled')
      await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
      const signal = AbortSignal.abort('private cancellation reason')
      await expect(sandbox.open({ scope, mode: 'create', signal })).rejects.toBeInstanceOf(OperationCancelledError)
      await expect(sandbox.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
      const { session } = await open(sandbox, scope)
      await session.write('/workspace/retained.txt', 'retained')
      await expect(sandbox.open({ scope, mode: 'attach', signal })).rejects.toBeInstanceOf(OperationCancelledError)
      await expect(sandbox.terminate({ scope, reason: 'manual', signal })).rejects.toBeInstanceOf(OperationCancelledError)
      await expect(session.readText('/workspace/retained.txt')).resolves.toBe('retained')
    })

    it('supports file operations and absolute paths', async () => {
      const session = await openContractSession(await make())
      await session.write('/workspace/a.txt', 'hello')
      expect(await session.readText('/workspace/a.txt')).toBe('hello')
      expect(await session.exists('/workspace/a.txt')).toBe(true)
      expect((await session.list('/workspace')).some((entry) => entry.path === '/workspace/a.txt')).toBe(true)
      expect((await session.stat('/workspace/a.txt')).kind).toBe('file')
      await session.mount(new Map([['SKILL.md', 'abc']]), '/skills/foo')
      await expect(session.readText('/skills/foo/SKILL.md')).resolves.toBe('abc')
      await expect(session.write('relative.txt', 'x')).rejects.toThrow()
    })

    it('has truthful exec availability', async () => {
      const session = await openContractSession(await make())
      if (opts.executor === 'unavailable') {
        expect(isExecCapableSession(session)).toBe(false)
        if ('exec' in session && typeof session.exec === 'function') await expect(session.exec('echo hi')).rejects.toBeInstanceOf(SandboxNoExecutorError)
        return
      }
      expect(await requireExecutor(session).exec('echo hi')).toMatchObject({ stdout: 'hi\n', stderr: '', exitCode: 0 })
    })

    if (opts.executor === 'available') it('honours exec timeout and cancellation', async () => {
      const session = requireExecutor(await openContractSession(await make()))
      await expect(session.exec('sleep 1', { timeoutMs: 10 })).rejects.toBeInstanceOf(OperationTimeoutError)
      await expect(session.exec('echo hi', { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OperationCancelledError)
    })
  })
}

/** Shared behavioural checks for adapters advertising `sandbox.text_search`. */
export function sandboxTextSearchContract(make: () => Sandbox | Promise<Sandbox>): void {
  describe('sandboxTextSearchContract', () => {
    it('searches literal and safe regex patterns without requiring exec', async () => {
      const sandbox = await make()
      expect(sandbox.capabilities).toContain('sandbox.text_search')
      const session = (await open(sandbox, contractScope('text-search'))).session
      if (!isTextSearchCapableSession(session)) throw new Error('Adapter advertises sandbox.text_search without searchText().')
      await session.write('/workspace/a.txt', 'Alpha one\nbeta two\n')
      await session.write('/workspace/b.txt', 'alpha three\n')
      await expect(session.searchText({ path: '/workspace', pattern: 'alpha', syntax: 'literal', caseSensitive: false, maxResults: 10 })).resolves.toMatchObject({
        complete: true,
        limitReasons: [],
        scannedFiles: 2,
        matches: [
          { path: '/workspace/a.txt', line: 1, text: 'Alpha one', textTruncated: false },
          { path: '/workspace/b.txt', line: 1, text: 'alpha three', textTruncated: false },
        ],
      })
      await expect(session.searchText({ path: '/workspace', pattern: '^(Alpha|beta)', syntax: 'safe_regex_v1', caseSensitive: true, maxResults: 10 })).resolves.toMatchObject({
        complete: true,
        matches: [
          { path: '/workspace/a.txt', line: 1 },
          { path: '/workspace/a.txt', line: 2 },
        ],
      })
    })

    it('reports bounded results as incomplete and rejects unsupported regex constructs', async () => {
      const sandbox = await make()
      const session = (await open(sandbox, contractScope('text-search-limits'))).session
      if (!isTextSearchCapableSession(session)) throw new Error('Adapter advertises sandbox.text_search without searchText().')
      await session.write('/workspace/a.txt', 'match\nmatch\n')
      await expect(session.searchText({ path: '/workspace', pattern: 'match', syntax: 'literal', caseSensitive: true, maxResults: 1 })).resolves.toMatchObject({
        complete: false,
        limitReasons: ['result_limit'],
        matches: [{ line: 1 }],
      })
      await expect(session.searchText({ path: '/workspace', pattern: '(a)\\1', syntax: 'safe_regex_v1', caseSensitive: true, maxResults: 10 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    })

    it('handles adversarial ambiguity and cancellation within the shared contract', async () => {
      const sandbox = await make()
      const session = (await open(sandbox, contractScope('text-search-adversarial'))).session
      if (!isTextSearchCapableSession(session)) throw new Error('Adapter advertises sandbox.text_search without searchText().')
      await session.write('/workspace/a.txt', `${'a'.repeat(100_000)}!\n`)
      await expect(session.searchText({ path: '/workspace', pattern: '(a|aa)+$', syntax: 'safe_regex_v1', caseSensitive: true, maxResults: 10 })).resolves.toMatchObject({ matches: [] })
      await expect(session.searchText({ path: '/workspace', pattern: 'a', syntax: 'literal', caseSensitive: true, maxResults: 10, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OperationCancelledError)
    })
  })
}

/** Verifies exact owner-scoped attachment across independently constructed clients. */
export function sandboxMultiClientContract(makePair: () => readonly [Sandbox, Sandbox] | Promise<readonly [Sandbox, Sandbox]>): void {
  describe('sandboxMultiClientContract', () => {
    it('attaches through a second client and invalidates both after termination', async () => {
      const [firstAdapter, secondAdapter] = await makePair()
      const scope = contractScope('shared', 'shared-run')
      await firstAdapter.registerOwner({ owner: scope.owner, mode: 'create' })
      await secondAdapter.registerOwner({ owner: scope.owner, mode: 'attach' })
      const first = (await firstAdapter.open({ scope, mode: 'create' })).session
      await first.write('/workspace/retained.txt', 'retained')
      const second = (await secondAdapter.open({ scope, mode: 'attach' })).session
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')
      await secondAdapter.terminate({ scope, reason: 'run_disposed' })
      await expect(first.readText('/workspace/retained.txt')).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(second.readText('/workspace/retained.txt')).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(firstAdapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    })
  })
}

/**
 * Verifies adapter-internal tenant compatibility and durable principal
 * offboarding fences. Framework-level business authorization is deliberately
 * out of scope: the adapter must only preserve the framework's authorized
 * actor boundary and fence that one attachment after a principal purge.
 */
export function sandboxActorBarrierContract(make: () => Sandbox | Promise<Sandbox>): void {
  describe('sandboxActorBarrierContract', () => {
    it('allows same-tenant actors and fences only the offboarded attachment', async () => {
      const sandbox = await make()
      const scope = contractScope('tenant-owner', 'shared-run', { tenantId: 'tenant-a' })
      const firstActor = { tenantId: 'tenant-a', principalId: 'principal-a' } as const
      const secondActor = { tenantId: 'tenant-a', principalId: 'principal-b' } as const

      await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
      await expect(sandbox.open({ scope, mode: 'create', identity: { tenantId: 'tenant-b', principalId: 'principal-a' } })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
      const first = (await sandbox.open({ scope, mode: 'create', identity: firstActor })).session
      const second = (await sandbox.open({ scope, mode: 'attach', identity: secondActor })).session
      await first.write('/workspace/retained.txt', 'retained')
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')

      await sandbox.administration.purge({
        selector: { kind: 'principal', namespace: scope.owner.namespace, tenantId: 'tenant-a', principalId: 'principal-a' },
        idempotencyKey: 'offboard-principal-a'
      })

      await expect(first.readText('/workspace/retained.txt')).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
      await expect(first.write('/workspace/denied.txt', 'denied')).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
      await expect(sandbox.open({ scope, mode: 'attach', identity: firstActor })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
      await second.write('/workspace/retained.txt', 'still available')
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('still available')
    })
  })
}
