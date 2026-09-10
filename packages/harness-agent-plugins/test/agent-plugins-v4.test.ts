import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineAgent } from '@purista/harness'
import {
	AGENT_PLUGIN_MANIFEST_SCHEMA,
	AGENT_PLUGIN_MCP_SCHEMA,
	AgentPluginLoadError,
	AgentPluginManifestError,
	AgentPluginTrustError,
	inspectAgentPlugin,
	inspectAgentPluginSync,
	loadAgentPlugins,
} from '../src/index.js'

const roots: string[] = []
const byteCompareForTest = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right))
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-v4-')); roots.push(value); return value }
function json(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
function manifest(directory: string, extra: Record<string, unknown> = {}): void {
	json(path.join(directory, 'plugin.json'), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'acme.research', version: '1.2.3', ...extra })
}
function skill(directory: string, id = 'research'): void {
	const file = path.join(directory, 'skills', id, 'SKILL.md'); fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, `---\nname: ${id}\ndescription: Research approved documents.\n---\n\n# Research\n`)
}
function mcp(directory: string): void {
	json(path.join(directory, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
		local: { type: 'stdio', command: './server' },
		remote: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { 'x-public': 'portable' } },
	} })
}

describe('Agent Plugins v4 public boundary', () => {
	it('returns deterministic frozen redacted inspection from sync and async entry points', async () => {
		const directory = root(); manifest(directory, { extensions: { vendor: { secret: 'hidden' } }, future: true }); skill(directory); mcp(directory)
		const sync = inspectAgentPluginSync({ root: directory })
		const asyncValue = await inspectAgentPlugin({ root: directory })
		expect(asyncValue).toEqual(sync)
		expect(sync).toMatchObject({ valid: true, trust: 'untrusted', manifest: { name: 'acme.research' }, skills: [{ name: 'research' }] })
		expect(sync.mcpServers).toEqual([
			{ name: 'local', transport: 'stdio', supported: false },
			{ name: 'remote', transport: 'streamable-http', supported: true },
		])
		expect(sync.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'untrusted', level: 'error' }),
			expect.objectContaining({ code: 'manifest_extensions_ignored', level: 'warn' }),
			expect.objectContaining({ code: 'manifest_unknown_field', item: 'future' }),
			expect.objectContaining({ code: 'transport_unsupported', item: 'local' }),
		]))
		expect(Object.isFrozen(sync)).toBe(true)
		expect(Object.isFrozen(sync.skills)).toBe(true)
		expect(JSON.stringify(sync)).not.toContain(directory)
		expect(JSON.stringify(sync)).not.toContain('example.test')
		expect(JSON.stringify(sync)).not.toContain('portable')
		expect(JSON.stringify(sync)).not.toContain('hidden')
	})

	it('sorts and deduplicates diagnostics by the exact public tuple', () => {
		const directory = root(); manifest(directory, { zed: true, alpha: true })
		fs.mkdirSync(path.join(directory, 'skills', 'z-bad'), { recursive: true }); fs.writeFileSync(path.join(directory, 'skills', 'z-bad', 'SKILL.md'), '# invalid')
		fs.mkdirSync(path.join(directory, 'skills', 'a-bad'), { recursive: true }); fs.writeFileSync(path.join(directory, 'skills', 'a-bad', 'SKILL.md'), '# invalid')
		mcp(directory)
		const diagnostics = inspectAgentPluginSync({ root: directory }).diagnostics
		const tuple = (item: typeof diagnostics[number]) => [item.level === 'error' ? '0' : '1', item.code, item.component ?? '', item.item ?? '', item.pluginName ?? '', item.message]
		const sorted = [...diagnostics].sort((left, right) => {
			const a = tuple(left); const b = tuple(right)
			for (let index = 0; index < a.length; index++) { const result = byteCompareForTest(a[index]!, b[index]!); if (result) return result }
			return 0
		})
		expect(diagnostics).toEqual(sorted)
		expect(new Set(diagnostics.map(item => JSON.stringify(tuple(item)))).size).toBe(diagnostics.length)
	})

	it('keeps malformed optional components isolated and rejects malformed manifests', () => {
		const directory = root(); manifest(directory); skill(directory, 'valid-skill')
		const invalid = path.join(directory, 'skills', 'bad', 'SKILL.md'); fs.mkdirSync(path.dirname(invalid), { recursive: true }); fs.writeFileSync(invalid, '# missing frontmatter')
		json(path.join(directory, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { bad: { type: 'streamable-http', url: '' } } })
		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.valid).toBe(true)
		expect(inspection.skills.map(item => item.name)).toEqual(['valid-skill'])
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'skill_invalid' }), expect.objectContaining({ code: 'server_invalid' })]))

		json(path.join(directory, 'plugin.json'), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'INVALID' })
		expect(inspectAgentPluginSync({ root: directory })).toMatchObject({ valid: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'manifest_invalid' })]) })
	})

	it('accepts valid manifest metadata and isolates every MCP transport/config shape', () => {
		const directory = root()
		manifest(directory, {
			description: 'Research', homepage: 'https://example.test', repository: 'repo', license: 'MIT',
			author: { name: 'Research Team', email: 'team@example.test', url: 'https://example.test/team' },
			keywords: ['research', 'remote'],
		})
		json(path.join(directory, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
			badShape: null,
			badSse: { type: 'sse', url: 'https://example.test/events' },
			badSseConfig: { type: 'sse', url: '' },
			badStdio: { type: 'stdio', command: '', args: [1] },
			goodStdio: { type: 'stdio', command: './server', args: ['--safe'], env: { MODE: 'test' }, cwd: './runtime' },
			badStdioEnv: { type: 'stdio', command: './server', env: { PLUGIN_ROOT: 'override' } },
			badStdioCwd: { type: 'stdio', command: './server', cwd: '/tmp' },
			badHttp: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { 'x-count': 1 } },
			goodHttp: { type: 'streamable-http', url: 'https://example.test/mcp' },
			unknown: { type: 'other' },
		} })

		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.valid).toBe(true)
		expect(inspection.manifest).toMatchObject({
			name: 'acme.research', description: 'Research', license: 'MIT', keywords: ['research', 'remote'],
			author: { name: 'Research Team' },
		})
		expect(inspection.mcpServers).toEqual([
			{ name: 'goodHttp', transport: 'streamable-http', supported: true },
			{ name: 'goodStdio', transport: 'stdio', supported: false },
		])
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'server_invalid', item: 'badShape' }),
			expect.objectContaining({ code: 'transport_unsupported', item: 'badSse' }),
			expect.objectContaining({ code: 'server_invalid', item: 'badSseConfig' }),
			expect.objectContaining({ code: 'transport_unsupported', item: 'goodStdio' }),
			expect.objectContaining({ code: 'server_invalid', item: 'badHttp' }),
			expect.objectContaining({ code: 'server_invalid', item: 'unknown' }),
		]))
	})

	it('diagnoses unsafe component containers without exposing their paths', () => {
		const directory = root(); manifest(directory)
		fs.writeFileSync(path.join(directory, 'skills'), 'not a directory')
		fs.mkdirSync(path.join(directory, 'mcp.json'))
		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.valid).toBe(true)
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'component_invalid', component: 'skills' }),
			expect.objectContaining({ code: 'component_invalid', component: 'mcp' }),
		]))
		expect(JSON.stringify(inspection.diagnostics)).not.toContain(directory)
	})

	it('diagnoses each immediate Skill directory missing SKILL.md', () => {
		const directory = root(); manifest(directory)
		fs.mkdirSync(path.join(directory, 'skills', 'missing'), { recursive: true })
		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.valid).toBe(true)
		expect(inspection.skills).toEqual([])
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'skill_invalid', component: 'skills', item: 'missing' })]))
	})

	it('applies the exact Core Skill frontmatter envelope and field rules', () => {
		const cases = [
			'---x\nname: bad\ndescription: bad\n---\n',
			'---\nname: bad\ndescription: bad\n---x\n',
			'---\nname: bad\nname: bad\ndescription: bad\n---\n',
			'---\nname: bad\ndescription: bad\nallowed-tools: " padded"\n---\n',
			'---\nname: bad\ndescription: bad\nallowed-tools: "one,two"\n---\n',
			`---\nname: bad\ndescription: bad\nallowed-tools: "one${String.fromCharCode(0x7f)}two"\n---\n`,
			`---\nname: bad\ndescription: ${'😀'.repeat(513)}\n---\n`,
		]
		for (const content of cases) {
			const directory = root(); manifest(directory)
			const file = path.join(directory, 'skills', 'bad', 'SKILL.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
			expect(inspectAgentPluginSync({ root: directory }).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'skill_invalid', item: 'bad' })]))
		}
	})

	it('reports malformed and mismatched lowercase digests without changing format validity', () => {
		const directory = root(); manifest(directory)
		expect(inspectAgentPluginSync({ root: directory, expectedDigest: 'A'.repeat(64) })).toMatchObject({ valid: true, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'digest_invalid' })]) })
		expect(inspectAgentPluginSync({ root: directory, expectedDigest: '0'.repeat(64) })).toMatchObject({ valid: true, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'digest_mismatch' })]) })
	})

	it('retains a calculated digest and every independent diagnostic for invalid manifests', async () => {
		for (const [manifestValue, reason] of [
			[undefined, 'manifest_missing'],
			['{', 'manifest_invalid'],
			[{ $schema: 'https://example.test/unknown', name: 'acme.research' }, 'schema_unsupported'],
		] as const) {
			const directory = root()
			if (typeof manifestValue === 'string') fs.writeFileSync(path.join(directory, 'plugin.json'), manifestValue)
			else if (manifestValue !== undefined) json(path.join(directory, 'plugin.json'), manifestValue)
			const inspection = inspectAgentPluginSync({ root: directory, expectedDigest: 'INVALID' })
			expect(inspection.valid).toBe(false)
			expect(inspection.digest).toMatch(/^[a-f0-9]{64}$/u)
			expect(inspection.diagnostics.map(item => item.code)).toEqual(['digest_invalid', reason, 'untrusted'].sort(byteCompareForTest))
			await expect(loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: inspection.digest! }] })).rejects.toMatchObject({ reason })
		}
		const directory = root()
		json(path.join(directory, 'plugin.json'), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'acme.research', unknown: true, version: 42 })
		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.digest).toMatch(/^[a-f0-9]{64}$/u)
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'manifest_invalid', pluginName: 'acme.research' }),
			expect.objectContaining({ code: 'manifest_unknown_field', pluginName: 'acme.research', item: 'unknown' }),
			expect.objectContaining({ code: 'untrusted', pluginName: 'acme.research' }),
		]))
	})

	it('keeps safely known trust and digest diagnostics when options or roots are invalid', () => {
		const directory = root(); manifest(directory)
		for (const inspection of [
			inspectAgentPluginSync({ root: path.join(directory, 'missing'), expectedDigest: 'INVALID' }),
			inspectAgentPluginSync({ root: directory, expectedDigest: 'INVALID' }, { maxFileBytes: 0 }),
		]) {
			expect(inspection.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['digest_invalid', 'untrusted']))
		}
	})

	it('loads atomically in input order only with location or explicit trust and exact digest', async () => {
		const first = root(); const second = root(); manifest(first); manifest(second, { name: 'acme.second' })
		const firstDigest = inspectAgentPluginSync({ root: first }).digest!
		const secondDigest = inspectAgentPluginSync({ root: second }).digest!
		await expect(loadAgentPlugins({ plugins: [{ root: first, expectedDigest: firstDigest }] })).rejects.toMatchObject({ name: 'AgentPluginTrustError', reason: 'untrusted', message: 'Agent Plugin trust verification failed.' })
		await expect(loadAgentPlugins({ plugins: [{ root: first, trust: 'trusted', expectedDigest: firstDigest }, { root: second, expectedDigest: secondDigest }] })).rejects.toBeInstanceOf(AgentPluginTrustError)
		const loaded = await loadAgentPlugins({ plugins: [{ root: first, expectedDigest: firstDigest }, { root: second, expectedDigest: secondDigest }], trustedRoots: [path.dirname(first)] })
		expect(loaded.map(item => item.inspection.manifest?.name)).toEqual(['acme.research', 'acme.second'])
		expect(Object.isFrozen(loaded)).toBe(true)
		await expect(loadAgentPlugins({ plugins: [{ root: first, trust: 'trusted', expectedDigest: firstDigest.toUpperCase() }] })).rejects.toMatchObject({ reason: 'digest_invalid' })
	})

	it.runIf(process.platform !== 'win32')('maps package symlink escapes to the exact load error', async () => {
		const directory = root(); manifest(directory); fs.symlinkSync('/tmp', path.join(directory, 'escape'))
		const inspection = inspectAgentPluginSync({ root: directory })
		expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'path_escape' })]))
		await expect(loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: '0'.repeat(64) }] })).rejects.toMatchObject({ reason: 'plugin_root_invalid' })
	})

	it('projects selected authentic definitions, exact bindings, and separate provenance', async () => {
		const directory = root(); manifest(directory); skill(directory); mcp(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		const input = z.object({ query: z.string() }); const output = z.object({ hits: z.array(z.string()) })
		const resolveHeaders: NonNullable<import('@purista/harness').McpBinding & { transport: 'http' }>['resolveHeaders'] = async () => ({ authorization: 'Bearer current' })
		const bindings = loaded.bindings({ skills: { research: { runtimes: ['python'] } }, mcpServers: {
			knowledge: { server: 'remote', headers: { 'X-Public': 'caller', Authorization: 'Bearer private' }, resolveHeaders, tools: {
				searchDocs: { remoteName: 'search_docs', description: 'Search approved documents.', input, output },
			} },
		} })
		expect(bindings.mcp).toEqual({ knowledge: { transport: 'http', url: 'https://example.test/mcp', headers: { authorization: 'Bearer private', 'x-public': 'caller' }, resolveHeaders } })
		expect(bindings.mcp.knowledge.resolveHeaders).toBe(resolveHeaders)
		expect(bindings.skills.research).toMatchObject({ kind: 'skill', id: 'research', runtimes: ['python'] })
		expect(bindings.mcpServers.knowledge.tools.searchDocs).toMatchObject({ kind: 'tool', id: 'searchDocs', remoteName: 'search_docs' })
		expect(() => defineAgent('answerAgent', {
			input: z.string(), output: z.string(), prompt: value => ({ role: 'user', content: value }), instructions: 'Answer.',
			skills: [bindings.skills.research], tools: [bindings.mcpServers.knowledge.tools.searchDocs],
		})).not.toThrow()
		expect(bindings.provenance).toEqual({
			skills: { research: { pluginName: 'acme.research', version: '1.2.3', digest, component: 'skill', skillId: 'research' } },
			mcpServers: { knowledge: { pluginName: 'acme.research', version: '1.2.3', digest, component: 'mcp-server', localServerId: 'knowledge', pluginServerName: 'remote', tools: {
				searchDocs: { pluginName: 'acme.research', version: '1.2.3', digest, component: 'mcp-tool', localToolId: 'searchDocs', remoteName: 'search_docs' },
			} } },
		})
		expect(Object.isFrozen(bindings.provenance.mcpServers.knowledge.tools)).toBe(true)
		expect(Object.keys(bindings.mcp.knowledge)).toEqual(['transport', 'url', 'headers', 'resolveHeaders'])
	})

	it('returns empty selected maps and never projects stdio', async () => {
		const directory = root(); manifest(directory); mcp(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		expect(loaded.bindings({ skills: {}, mcpServers: {} })).toEqual({ skills: {}, mcpServers: {}, mcp: {}, provenance: { skills: {}, mcpServers: {} } })
		expect(() => loaded.bindings({ skills: {}, mcpServers: { local: { server: 'local', tools: { run: { remoteName: 'run', description: 'Run.', input: z.object({}), output: z.object({}) } } } } })).toThrow(expect.objectContaining({ reason: 'transport_unsupported' }))
	})

	it('rejects incomplete MCP selection shape before portable server lookup', async () => {
		const directory = root(); manifest(directory); mcp(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		for (const selection of [{ server: 'missing' }, { server: 'missing', tools: null }]) {
			expect(() => loaded.bindings({ skills: {}, mcpServers: { invalid: selection } } as never)).toThrow(expect.objectContaining({ reason: 'invalid_selection' }))
		}
	})

	it('resolves selection getters once in the specified sorted phase order', async () => {
		const directory = root(); manifest(directory); skill(directory); mcp(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		let mcpReads = 0
		const mcpSelections = Object.defineProperty({}, 'zServer', { enumerable: true, get() { mcpReads++; throw new Error('private') } })
		expect(() => loaded.bindings({ skills: { aMissing: { runtimes: [] } }, mcpServers: mcpSelections } as never)).toThrow(expect.objectContaining({ reason: 'skill_not_found' }))
		expect(mcpReads).toBe(0)

		let lateToolReads = 0
		const tools = Object.defineProperties({}, {
			zTool: { enumerable: true, get() { lateToolReads++; throw new Error('private') } },
			aTool: { enumerable: true, value: { remoteName: 'a_tool', description: '', input: z.object({}), output: z.object({}) } },
		})
		expect(() => loaded.bindings({ skills: {}, mcpServers: { knowledge: { server: 'remote', tools } } } as never)).toThrow(expect.objectContaining({ reason: 'invalid_selection' }))
		expect(lateToolReads).toBe(0)
	})

	it('defers caller header access until after URL and portable-header validation', async () => {
		const directory = root(); manifest(directory)
		json(path.join(directory, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
			badUrl: { type: 'streamable-http', url: 'http://example.test/mcp' },
			badPortable: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { authorization: 'portable-secret' } },
			remote: { type: 'streamable-http', url: 'https://example.test/mcp' },
		} })
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		const schema = z.object({})
		const makeSelection = (server: string, counter: { value: number }) => Object.defineProperties({
			server, tools: { callRemote: { remoteName: 'call_remote', description: 'Call remote.', input: schema, output: schema } },
		}, { headers: { enumerable: true, get() { counter.value++; throw new Error('private credential') } } })
		for (const [server, reason] of [['missing', 'mcp_server_not_found'], ['badUrl', 'invalid_selection'], ['badPortable', 'invalid_http_headers']] as const) {
			const counter = { value: 0 }
			expect(() => loaded.bindings({ skills: {}, mcpServers: { selected: makeSelection(server, counter) } } as never)).toThrow(expect.objectContaining({ reason }))
			expect(counter.value).toBe(0)
		}
		const reached = { value: 0 }
		expect(() => loaded.bindings({ skills: {}, mcpServers: { selected: makeSelection('remote', reached) } } as never)).toThrow(expect.objectContaining({ reason: 'invalid_http_headers', message: 'Agent Plugin binding selection is invalid.' }))
		expect(reached.value).toBe(1)
	})

	it('maps public binding failures with exact cross-phase precedence', async () => {
		const directory = root(); manifest(directory); skill(directory)
		json(path.join(directory, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
			remote: { type: 'streamable-http', url: 'https://example.test/mcp' },
			badUrl: { type: 'streamable-http', url: 'http://example.test/mcp' },
			badPortable: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { authorization: 'secret' } },
		} })
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		const schema = z.object({})
		const tool = (remoteName = 'call_remote') => ({ remoteName, description: 'Call remote.', input: schema, output: schema })
		const cases: ReadonlyArray<readonly [() => unknown, string]> = [
			[() => loaded.bindings({ skills: { missing: { runtimes: [] } }, mcpServers: {} }), 'skill_not_found'],
			[() => loaded.bindings({ skills: { research: { runtimes: ['ruby'] as never } }, mcpServers: {} }), 'invalid_selection'],
			[() => loaded.bindings({ skills: {}, mcpServers: { selected: { server: 'missing', tools: { callRemote: tool() } } } }), 'mcp_server_not_found'],
			[() => loaded.bindings({ skills: {}, mcpServers: { one: { server: 'remote', tools: { callOne: tool() } }, two: { server: 'remote', tools: { callTwo: tool('other') } } } }), 'duplicate_selection'],
			[() => loaded.bindings({ skills: {}, mcpServers: { selected: { server: 'remote', tools: { callOne: tool('same'), callTwo: tool('same') } } } }), 'duplicate_selection'],
			[() => loaded.bindings({ skills: {}, mcpServers: { selected: { server: 'badUrl', tools: { callRemote: tool() }, headers: { authorization: 'private' } } } }), 'invalid_selection'],
			[() => loaded.bindings({ skills: {}, mcpServers: { selected: { server: 'badPortable', tools: { callRemote: tool() } } } }), 'invalid_http_headers'],
			[() => loaded.bindings({ skills: {}, mcpServers: { selected: { server: 'remote', tools: { callRemote: tool() }, headers: { accept: 'private' } } } }), 'invalid_http_headers'],
		]
		for (const [action, reason] of cases) {
			try { action(); throw new Error('expected') } catch (error) {
				expect(error).toMatchObject({ name: 'AgentPluginLoadError', reason, message: 'Agent Plugin binding selection is invalid.' })
				expect(error).not.toHaveProperty('cause')
				expect(String(error)).not.toContain('secret')
				expect(String(error)).not.toContain('private')
			}
		}
	})

	it('re-snapshots before reading hostile selections and fails changed packages', async () => {
		const directory = root(); manifest(directory); skill(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		let accessed = 0
		const selections = Object.defineProperty({}, 'skills', { enumerable: true, get() { accessed++; return {} } })
		fs.writeFileSync(path.join(directory, 'changed.txt'), 'changed')
		expect(() => loaded.bindings(selections as never)).toThrow(expect.objectContaining({ reason: 'digest_mismatch' }))
		expect(accessed).toBe(0)
	})

	it('reports digest mismatch before parsing deleted or malformed changed manifests', async () => {
		for (const mutate of [
			(directory: string) => fs.rmSync(path.join(directory, 'plugin.json')),
			(directory: string) => fs.writeFileSync(path.join(directory, 'plugin.json'), '{'),
		]) {
			const directory = root(); manifest(directory)
			const digest = inspectAgentPluginSync({ root: directory }).digest!
			const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
			let accessed = 0
			const selections = Object.defineProperty({}, 'skills', { enumerable: true, get() { accessed++; return {} } })
			mutate(directory)
			expect(() => loaded.bindings(selections as never)).toThrow(expect.objectContaining({ name: 'AgentPluginTrustError', reason: 'digest_mismatch' }))
			expect(accessed).toBe(0)
		}
	})

	it('validates every selection before materializing any Core definition', async () => {
		const directory = root(); manifest(directory); mcp(directory)
		const digest = inspectAgentPluginSync({ root: directory }).digest!
		const [loaded] = await loadAgentPlugins({ plugins: [{ root: directory, trust: 'trusted', expectedDigest: digest }] })
		const schema = z.object({ value: z.string() })
		expect(() => loaded.bindings({ skills: {}, mcpServers: {
			first: { server: 'remote', tools: { validTool: { remoteName: 'valid_tool', description: 'Valid.', input: schema, output: schema } } },
			second: { server: 'missing', tools: { laterTool: { remoteName: 'later_tool', description: 'Later.', input: schema, output: schema } } },
		} })).toThrow(expect.objectContaining({ reason: 'mcp_server_not_found' }))
		const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
		expect(source.indexOf('for (const plan of mcpPlans)')).toBeLessThan(source.indexOf('defineMcpServer(plan.localId'))
	})

	it('uses fixed content-free errors and does no process or network work', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		await expect(loadAgentPlugins({ plugins: [] } as never)).rejects.toEqual(expect.objectContaining({ reason: 'manifest_invalid', message: 'Agent Plugin package is invalid.' }))
		expect(new AgentPluginManifestError('manifest_invalid')).not.toHaveProperty('cause')
		expect(new AgentPluginLoadError('invalid_selection')).not.toHaveProperty('cause')
		expect(new AgentPluginTrustError('untrusted')).not.toHaveProperty('cause')
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).not.toMatch(/node:child_process|\bspawn\s*\(/u)
		fetchSpy.mockRestore()
	})
})
