import { expect, it } from 'vitest'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { invokeBuiltinTool } from '../src/tools/index.js'
import { SandboxNoExecutorError, ValidationError } from '../src/errors/index.js'

async function openSandbox() {
  const sandbox = inMemorySandbox()
  const scope = { owner: { namespace: 'tools-test', id: 's1', instanceId: '01J00000000000000000000000' }, partition: { kind: 'shared' as const }, lifetime: 'run' as const, runId: 'r1' }
  await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
  return (await sandbox.open({ scope, mode: 'create' })).session
}

it('dispatches alias and enforces bash availability', async () => {
  const session = await openSandbox()
  await expect(invokeBuiltinTool('Bash', { command: 'echo hi' }, session)).rejects.toBeInstanceOf(SandboxNoExecutorError)
})

it('grep falls back to read+match when executor unavailable', async () => {
  const session = await openSandbox()
  await session.write('/workspace/a.txt', 'hello\nworld\nhello again')
  const result = await invokeBuiltinTool('grep', { pattern: 'hello', path: '/workspace', maxResults: 10 }, session) as { matches: Array<{ path: string }> }
  expect(result.matches.length).toBe(2)
  expect(result.matches.every((m) => m.path === '/workspace/a.txt')).toBe(true)
})

it('grep scans through sandbox fs APIs when executor is available', async () => {
  const session = await openSandbox()
  await session.write('/workspace/a.txt', 'safe\nneedle')

  const execCalls: string[] = []
  Object.defineProperty(session, 'executor', { value: 'available' })
  session.exec = async (command) => {
    execCalls.push(command)
    return { stdout: '/tmp/pwned:1:pwned', stderr: '', exitCode: 0, durationSeconds: 0 }
  }

  const result = await invokeBuiltinTool(
    'grep',
    { pattern: 'needle"; touch /tmp/pwned; echo "', path: '/workspace; touch /tmp/path-pwned', maxResults: 10 },
    session
  ) as { matches: Array<{ path: string }> }

  expect(result.matches).toEqual([])
  expect(execCalls).toEqual([])
})

it('grep converts invalid regex patterns into tool input validation errors', async () => {
  const session = await openSandbox()

  await expect(invokeBuiltinTool('grep', { pattern: '[', path: '/workspace' }, session)).rejects.toMatchObject({
    meta: { where: 'tool_input' }
  })
  await expect(invokeBuiltinTool('grep', { pattern: '[', path: '/workspace' }, session)).rejects.toBeInstanceOf(ValidationError)
})

it('grep rejects oversized patterns and nested unbounded quantifiers before compiling', async () => {
  const session = await openSandbox()
  await session.write('/workspace/a.txt', 'abab')

  await expect(invokeBuiltinTool('grep', { pattern: 'a'.repeat(1_001), path: '/workspace' }, session)).rejects.toMatchObject({
    meta: { where: 'tool_input' }
  })
  for (const pattern of ['(a+)+$', '(x*)*', '(a+b){2,}!']) {
    await expect(invokeBuiltinTool('grep', { pattern, path: '/workspace' }, session)).rejects.toBeInstanceOf(ValidationError)
  }

  // Bounded or non-nested quantifiers stay accepted.
  const result = await invokeBuiltinTool('grep', { pattern: '(ab)+', path: '/workspace', maxResults: 5 }, session) as { matches: unknown[] }
  expect(result.matches.length).toBe(1)
})

it('edit writes new_string literally when it contains regex replacement patterns', async () => {
  const session = await openSandbox()
  await session.write('/workspace/file.txt', 'price = OLD;')

  const result = await invokeBuiltinTool('edit', {
    path: '/workspace/file.txt',
    old_string: 'OLD',
    new_string: '$& and $$ and $` stay literal'
  }, session)

  expect(result).toEqual({ replaced: 1 })
  expect(await session.readText('/workspace/file.txt')).toBe('price = $& and $$ and $` stay literal;')
})
