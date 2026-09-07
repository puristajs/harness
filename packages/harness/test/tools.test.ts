import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { invokeBuiltinTool, resolveEnabledBuiltinTools } from '../src/tools/index.js'
import { SandboxNoExecutorError, ValidationError } from '../src/errors/index.js'
import { z } from 'zod'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineMcpServer } from '../src/definitions/mcp-server.js'
import { builtInTools } from '../src/tools/index.js'
import { bindBuiltInTool, bindHostToolSeam, bindMcpTool, bindPortableTool, createAgentExecutableBinding } from '../src/tools/bindings.js'
import { createDefinitionIdentity, freezeDefinition } from '../src/definitions/identity.js'
import type { HostToolDefinition } from '../src/definitions/types.js'
import { projectModelSchema } from '../src/schema/json-schema.js'

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

it('exposes immutable built-in definition references with exact capabilities', () => {
  expect(Object.keys(builtInTools)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'list'])
  expect(builtInTools.bash.requires.sandbox).toEqual(['sandbox.exec'])
  expect(builtInTools.grep.requires.sandbox).toEqual(['sandbox.text_search'])
  expect(builtInTools.read.requires.sandbox).toEqual(['sandbox.fs'])
  expect(Object.isFrozen(builtInTools)).toBe(true)
  expect(Object.values(builtInTools).every(Object.isFrozen)).toBe(true)
})

it('accepts readonly mount as a portable tool sandbox requirement', () => {
  const definition = defineTool('readSnapshot', {
    description: 'Read an immutable snapshot.',
    input: z.object({ path: z.string() }),
    output: z.object({ value: z.string() }),
    requires: { sandbox: ['sandbox.readonly_mount'] },
    async handler() { return { value: 'snapshot' } },
  })

  expect(definition.requires.sandbox).toEqual(['sandbox.readonly_mount'])
})

it('prepares a portable binding without validation, policy, registry lookup, or lifecycle side effects', async () => {
  const definition = defineTool('uppercase', { description: 'Uppercase text.', input: z.object({ value: z.string() }), output: z.object({ value: z.string() }), async handler(_context, input) { return { value: input.value.toUpperCase() } } })
  const binding = bindPortableTool(definition)
  expect(binding.definitionIdentity).toMatchObject({ kind: 'tool', id: 'uppercase' })
  expect(binding.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect('definition' in binding).toBe(false)
  expect(binding.implementationKind).toBe('portable')
  expect(Object.isFrozen(binding)).toBe(true)
  await expect(binding.invokeValidated({ signal: new AbortController().signal } as never, { value: 'ok' }, { value: 'ok' })).resolves.toEqual({ value: 'OK' })
})

it('runs a declared workflow tool through the managed binding with exact caller events and call coalescing', async () => {
	let effects = 0
	let observedContext: unknown
	const uppercase = defineTool('workflowUppercase', {
		description: 'Uppercase workflow input.', input: z.object({ value: z.string() }), output: z.object({ value: z.string() }),
		async handler(context, input) {
			effects += 1
			observedContext = context
			return { value: input.value.toUpperCase() }
		},
	})
	const workflow = defineWorkflow('toolWorkflow', {
		input: z.string(), output: z.string(), tools: [uppercase],
		async handler({ input, tools }) {
			const [first, replay] = await Promise.all([
				tools.workflowUppercase.run({ value: input }, { callId: 'uppercase' }),
				tools.workflowUppercase.run({ value: input }, { callId: 'uppercase' }),
			])
			expect(replay).toEqual(first)
			return first.value
		},
	})
	const harness = await defineHarness({ name: 'workflowToolPipeline' }).addWorkflow(workflow).getInstance({})
	const session = await harness.getSession('tool-workflow')
	const events = []
	for await (const event of session.workflows.toolWorkflow.stream('hello')) events.push(event)
	expect(effects).toBe(1)
	expect(observedContext).toMatchObject({ caller: { kind: 'workflow', workflowId: 'toolWorkflow' }, toolId: 'workflowUppercase', callId: 'uppercase' })
	expect(Object.isFrozen((observedContext as { caller: object }).caller)).toBe(true)
	expect('agentId' in (observedContext as object)).toBe(false)
	expect(events).toEqual(expect.arrayContaining([
		expect.objectContaining({ type: 'tool.started', caller: { kind: 'workflow', workflowId: 'toolWorkflow' }, toolId: 'workflowUppercase', callId: 'uppercase' }),
		expect.objectContaining({ type: 'tool.finished', caller: { kind: 'workflow', workflowId: 'toolWorkflow' }, toolId: 'workflowUppercase', callId: 'uppercase' }),
		expect.objectContaining({ type: 'run.finished', outcome: expect.objectContaining({ status: 'completed', output: 'HELLO' }) }),
	]))
	await session.destroy()
	await harness.close()
})

it('prepares built-in execution and a non-callable host seam without exposing a lookup registry', async () => {
  const builtIn = bindBuiltInTool(builtInTools.read, async (_context, input) => ({ source: _context.harnessName, input }))
  await expect(builtIn.invokeValidated({ harnessName: 'sandbox' } as never, { path: '/x' })).resolves.toMatchObject({ source: 'sandbox' })
  const hostValue = { kind: 'tool' as const, id: 'invokeCommand', description: 'Invoke one command.', input: z.object({ value: z.string() }), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true }) }
  const host = freezeDefinition(hostValue, createDefinitionIdentity('host-tool', 'invokeCommand')) as unknown as HostToolDefinition
  const seam = bindHostToolSeam(host)
  expect(seam).toMatchObject({ id: 'invokeCommand', implementationKind: 'host', contractDigest: expect.stringMatching(/^sha256:/) })
	 expect('definition' in seam).toBe(false)
  expect('invokeValidated' in seam).toBe(false)
  expect(Object.isFrozen(seam)).toBe(true)
})

it('binds MCP tools only to their exact owner identity and remote name', () => {
	const server = defineMcpServer('knowledge', { tools: { search: { remoteName: 'search_remote', description: 'Search.', input: z.string(), output: z.string() } } })
	const binding = bindMcpTool(server.tools.search, async () => 'ok')
	expect(binding).toMatchObject({ implementationKind: 'mcp', id: 'search' })
	const identity = binding.definitionIdentity
	const source = { id: 'search', description: 'Search.', input: server.tools.search.input, output: server.tools.search.output,
		implementationKind: 'mcp' as const, definitionIdentity: identity, digestDefinition: ['mcp-tool', 'search'] as const,
		outputValidation: 'required' as const, async invokeValidated() { return 'ok' } }
	expect(() => createAgentExecutableBinding({ ...source, mcpOwner: ['mcp-server', 'other'], remoteMcpName: 'search_remote' })).toThrow(TypeError)
	expect(() => createAgentExecutableBinding({ ...source, mcpOwner: ['mcp-server', 'knowledge'], remoteMcpName: 'other_remote' })).toThrow(TypeError)
})

it('rejects every non-canonical digest input and freezes the finalized binding', () => {
	const tool = defineTool('digestTool', { description: 'Digest.', input: z.string(), output: z.string(), async handler() { return 'ok' } })
	const source = { id: tool.id, description: tool.description, input: tool.input, output: tool.output,
		implementationKind: 'portable' as const, definitionIdentity: createDefinitionIdentity('tool', tool.id),
		mcpOwner: null, remoteMcpName: null, outputValidation: 'required' as const, async invokeValidated() { return 'ok' } }
	const sparse: unknown[] = ['tool', tool.id]
	sparse.length = 3
	const extra = ['tool', tool.id]
	;(extra as unknown as Record<string, unknown>)['extra'] = true
	for (const digestDefinition of [sparse, extra, ['tool', tool.id, { [Symbol('private')]: true }],
		['tool', tool.id, { value: undefined }], ['tool', tool.id, { value() {} }], ['tool', tool.id, new Date()]]) {
		expect(() => createAgentExecutableBinding({ ...source, digestDefinition })).toThrow(TypeError)
	}
	const binding = createAgentExecutableBinding({ ...source, digestDefinition: ['tool', tool.id] })
	expect(Object.isFrozen(binding)).toBe(true)
	expect(Object.isFrozen(binding.definitionIdentity)).toBe(true)
})

it('orders canonical digest object keys by Unicode code point', () => {
	const definition = defineTool('unicodeDigest', { description: 'Unicode.',
		input: z.object({ '\uE000': z.string(), '𐀀': z.string() }), output: z.string(), async handler() { return 'ok' } })
	const binding = bindPortableTool(definition)
	const preimage = ['harness.binding.v1', definition.id, 'portable', ['tool', definition.id], null, null,
		projectModelSchema(definition.input, 'tool_input', definition.id)]
	const expected = `sha256:${createHash('sha256').update(canonicalForTest(preimage), 'utf8').digest('hex')}`
	expect(binding.contractDigest).toBe(expected)
})

function canonicalForTest(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`
	const points = (text: string) => Array.from(text, character => character.codePointAt(0)!)
	const compare = (left: string, right: string) => {
		const a = points(left); const b = points(right)
		for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!
		return a.length - b.length
	}
	return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compare(left, right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonicalForTest(child)}`).join(',')}}`
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
