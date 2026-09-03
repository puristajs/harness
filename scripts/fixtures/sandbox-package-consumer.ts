import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineHarness, inMemorySandbox, SandboxStateLostError, type SandboxScope } from '@purista/harness'
import { dockerSandbox } from '@purista/harness-sandbox-docker'
import * as dockerExports from '@purista/harness-sandbox-docker'

const scope: SandboxScope = {
  owner: {
    namespace: 'packed-consumer',
    id: 'files',
    instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  },
  partition: { kind: 'shared' },
  lifetime: 'session'
}
const sandbox = inMemorySandbox()
await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
const opened = await sandbox.open({ scope, mode: 'create' })
await opened.session.write('/workspace/check.txt', 'retained')
await opened.session.close()
const attached = await sandbox.open({ scope, mode: 'attach' })
assert.equal(await attached.session.readText('/workspace/check.txt'), 'retained')
await attached.session.close()
await sandbox.terminate({ scope, reason: 'manual' })
await assert.rejects(sandbox.open({ scope, mode: 'attach' }), SandboxStateLostError)

// Constructing the optional adapter needs no engine, Framework, or model call.
const docker = dockerSandbox({
  root: join(dirname(fileURLToPath(import.meta.url)), 'private-state'),
  image: `sha256:${'a'.repeat(64)}`
})
await docker.registerOwner({ owner: scope.owner, mode: 'create' })
defineHarness({ name: 'packed-consumer' }).sandbox(docker)
assert.deepEqual(Object.keys(dockerExports), ['dockerSandbox'])
assert.throws(() => import.meta.resolve('@purista/core'), { code: 'ERR_MODULE_NOT_FOUND' })
assert.throws(() => import.meta.resolve('@purista/harness-sandbox-docker/dist/lifecycle.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
assert.throws(() => import.meta.resolve('@purista/harness/src/sandbox/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })

// Checked against installed declaration files, with no source aliases or shims.
async function checkCapabilityTypes(): Promise<void> {
  const files = await sandbox.open({ scope, mode: 'create' })
  // @ts-expect-error Files-only attachments do not provide execution.
  await files.session.exec('true')
  const executable = await docker.open({ scope, mode: 'create' })
  await executable.session.exec('true')
  await executable.session.spawn('cat')
  // @ts-expect-error An owner must include its immutable incarnation.
  await docker.open({ scope: { owner: { namespace: 'x', id: 'x' }, partition: { kind: 'shared' }, lifetime: 'session' }, mode: 'create' })
}
void checkCapabilityTypes
console.log('Packed Harness and Docker addon: isolated runtime, declarations, and public boundaries passed.')
