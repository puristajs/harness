import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessError, type SandboxScope, type SandboxSessionBase } from '@purista/harness'
import { dockerSandbox } from '@purista/harness-sandbox-docker'

async function main(): Promise<void> {
  const image = process.env['PURISTA_DOCKER_SANDBOX_IMAGE']
  if (!image) throw new Error('Set PURISTA_DOCKER_SANDBOX_IMAGE to an already-provisioned immutable image.')
  const context = process.env['PURISTA_DOCKER_SANDBOX_CONTEXT']
  const root = await mkdtemp(join(tmpdir(), 'purista-docker-example-'))
  const scope: SandboxScope = {
    owner: {
      namespace: 'local-docker-example',
      id: 'file-roundtrip',
      instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J'
    },
    partition: { kind: 'shared' },
    lifetime: 'session',
  }
  const options = { root, image, ...(context ? { context } : {}) }
  const sessions: SandboxSessionBase[] = []
  const failures: unknown[] = []
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let sandbox: ReturnType<typeof dockerSandbox> | undefined

  try {
    sandbox = dockerSandbox(options)
    await sandbox.registerOwner({ owner: scope.owner, mode: 'create', signal: cancellation.signal })
    const created = await sandbox.open({ scope, mode: 'create', signal: cancellation.signal })
    sessions.push(created.session)
    assert.equal(created.disposition, 'created')
    await created.session.write('/workspace/message.txt', 'Files survive attachment release.\n')
    const command = await created.session.exec('cat message.txt', { cwd: '/workspace', signal: cancellation.signal })
    assert.equal(command.exitCode, 0)
    assert.equal(command.stdout, 'Files survive attachment release.\n')
    await created.session.close()

    // A separately constructed client uses the same logical scope and private root.
    sandbox = dockerSandbox(options)
    await sandbox.registerOwner({ owner: scope.owner, mode: 'attach', signal: cancellation.signal })
    const attached = await sandbox.open({ scope, mode: 'attach', signal: cancellation.signal })
    sessions.push(attached.session)
    assert.equal(attached.disposition, 'attached')
    assert.equal(await attached.session.readText('/workspace/message.txt'), 'Files survive attachment release.\n')
    console.log('File/exec roundtrip and independent-client reattachment passed.')
  } catch (error) {
    failures.push(error)
  } finally {
    // Cleanup deliberately has no cancelled signal: ownership must be released.
    for (const session of sessions) {
      try { await session.close() } catch (error) { failures.push(error) }
    }
    let terminated = sandbox === undefined
    if (sandbox) {
      try {
        await sandbox.terminate({ scope, reason: 'manual' })
        terminated = true
      } catch (error) {
        failures.push(error)
        console.error('Cleanup needs retry. Keep the private metadata and retry terminate with these application-owned values:')
        console.error(JSON.stringify({ options, scope }))
      }
    }
    if (terminated) {
      try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    }
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Sandbox lifecycle example failed.')
  console.log('Owned sandbox resources and temporary metadata cleaned up.')
}

void main().catch((error: unknown) => {
  if (error instanceof AggregateError) {
    console.error(error.message)
    for (const failure of error.errors) console.error(failure instanceof HarnessError ? failure.code : 'EXAMPLE_OPERATION_FAILED')
  } else {
    console.error(error instanceof Error ? error.message : 'Example setup failed.')
  }
  process.exitCode = 1
})
