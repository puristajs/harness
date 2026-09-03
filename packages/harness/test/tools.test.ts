import { expect, it } from 'vitest'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { invokeBuiltinTool, resolveEnabledBuiltinTools } from '../src/tools/index.js'
import { SandboxNoExecutorError, ValidationError } from '../src/errors/index.js'

async function openSandbox() {
  const sandbox = inMemorySandbox()
  const scope = {
    owner: { namespace: 'tools-test', id: 's1', instanceId: '01J00000000000000000000000' },
    partition: { kind: 'shared' as const },
    lifetime: 'run' as const,
    runId: 'r1',
  }
  await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
  return (await sandbox.open({ scope, mode: 'create' })).session
}

it('keeps built-in tools disabled unless an agent explicitly enables them', () => {
  expect(resolveEnabledBuiltinTools(undefined)).toEqual([])
  expect(resolveEnabledBuiltinTools(false)).toEqual([])
  expect(resolveEnabledBuiltinTools(['read', 'grep'])).toEqual(['read', 'grep'])
})

it('dispatches alias and enforces bash availability', async () => {
  const session = await openSandbox()
  await expect(invokeBuiltinTool('Bash', { command: 'echo hi' }, session)).rejects.toBeInstanceOf(
    SandboxNoExecutorError,
  )
})

it('grep works with the zero-configuration in-memory sandbox', async () => {
  const session = await openSandbox()
  await session.write('/workspace/a.txt', 'hello\nworld\nhello again')
  const result = (await invokeBuiltinTool(
    'grep',
    { pattern: 'hello', path: '/workspace', maxResults: 10 },
    session,
  )) as { matches: Array<{ path: string }> }
  expect(result.matches.length).toBe(2)
  expect(result.matches.every((m) => m.path === '/workspace/a.txt')).toBe(true)
})

it('grep delegates only to the sandbox text-search capability', async () => {
  const session = await openSandbox()
  const expected = {
    matches: [{ path: '/workspace/a.txt', line: 2, text: 'needle', textTruncated: false }],
    complete: true,
    limitReasons: [],
    scannedFiles: 1,
    scannedBytes: 11,
  }
  let request: unknown
  session.searchText = async (value) => {
    request = value
    return expected
  }
  session.list = async () => { throw new Error('grep must not list files in core') }
  session.read = async () => { throw new Error('grep must not read files in core') }
  session.readText = async () => { throw new Error('grep must not read text in core') }

  const result = (await invokeBuiltinTool(
    'grep',
    { pattern: 'needle', path: '/workspace', syntax: 'literal', maxResults: 10 },
    session,
  ))

  expect(result).toEqual(expected)
  expect(request).toMatchObject({ pattern: 'needle', path: '/workspace', syntax: 'literal', maxResults: 10 })
})

it('grep converts invalid regex patterns into tool input validation errors', async () => {
  const session = await openSandbox()

  await expect(invokeBuiltinTool('grep', { pattern: '[', path: '/workspace' }, session)).rejects.toMatchObject({
    meta: { where: 'tool_input' },
  })
  await expect(invokeBuiltinTool('grep', { pattern: '[', path: '/workspace' }, session)).rejects.toBeInstanceOf(
    ValidationError,
  )
})

it('grep rejects oversized or unsupported patterns while accepting RE2-safe nested quantifiers', async () => {
  const session = await openSandbox()
  await session.write('/workspace/a.txt', 'aaaa')

  await expect(
    invokeBuiltinTool('grep', { pattern: 'a'.repeat(513), path: '/workspace' }, session),
  ).rejects.toMatchObject({
    meta: { where: 'tool_input' },
  })
  for (const pattern of ['(a)\\1', '(?=a)', '\\p{Letter}']) {
    await expect(invokeBuiltinTool('grep', { pattern, path: '/workspace' }, session)).rejects.toBeInstanceOf(
      ValidationError,
    )
  }

  // RE2 executes nested quantifiers without catastrophic backtracking.
  const result = (await invokeBuiltinTool(
    'grep',
    { pattern: '(a+)+$', path: '/workspace', maxResults: 5 },
    session,
  )) as { matches: unknown[] }
  expect(result.matches.length).toBe(1)
})

it('edit writes new_string literally when it contains regex replacement patterns', async () => {
  const session = await openSandbox()
  await session.write('/workspace/file.txt', 'price = OLD;')

  const result = await invokeBuiltinTool(
    'edit',
    {
      path: '/workspace/file.txt',
      old_string: 'OLD',
      new_string: '$& and $$ and $` stay literal',
    },
    session,
  )

  expect(result).toEqual({ replaced: 1 })
  expect(await session.readText('/workspace/file.txt')).toBe('price = $& and $$ and $` stay literal;')
})
