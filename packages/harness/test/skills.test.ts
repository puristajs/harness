import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineSkill } from '../src/definitions/skill.js'
import { OperationCancelledError, SkillManifestError } from '../src/errors/index.js'
import { bashSandbox, inMemorySandbox } from '../src/sandbox/index.js'
import { createReadSkillBinding, loadSkillSnapshots } from '../src/skills/runtime.js'
import { defineAgent } from '../src/definitions/agent.js'
import { FakeSandbox } from '../src/testing/fakeSandbox.js'
import { localDirectorySandbox } from '../src/local/local-sandbox.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function skill(name: string, body = 'Use concise answers.', extra = ''): Promise<ReturnType<typeof defineSkill>> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h4-skill-'))
	roots.push(root)
	const directory = path.join(root, name)
	await fs.mkdir(path.join(directory, 'scripts'), { recursive: true })
	await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Explain the selected capability.\n${extra}---\n${body}`)
	await fs.writeFile(path.join(directory, 'notes.txt'), 'snapshot one')
	await fs.writeFile(path.join(directory, 'scripts', 'run.sh'), 'printf changed > /skills/demo/notes.txt')
	return defineSkill(name, { directory: pathToFileURL(directory) })
}

async function open(adapter: ReturnType<typeof inMemorySandbox> | ReturnType<typeof bashSandbox>) {
	const owner = { namespace: 'skill-test', id: 'skill', instanceId: '01J00000000000000000000000' }
	const scope = { owner, partition: { kind: 'shared' as const }, lifetime: 'session' as const }
	await adapter.registerOwner({ owner, mode: 'create' })
	return (await adapter.open({ scope, mode: 'create' })).session
}

describe('v4 Agent Skill snapshots', () => {
	it('loads once, keeps a detached snapshot, and exposes a confined read_skill binding', async () => {
		const definition = await skill('demo', 'Use concise answers.', 'allowed-tools: bash write\nmetadata:\n  owner: docs\n')
		const loaded = await loadSkillSnapshots([definition])
		expect(loaded.demo.manifest).toMatchObject({ 'allowed-tools': 'bash write', metadata: { owner: 'docs' } })
		await fs.writeFile(path.join(new URL(definition.directory).pathname, 'notes.txt'), 'changed later')
		const reader = createReadSkillBinding(defineAgent('readerAgent', { model: 'chat', instructions: 'Read.' }), loaded)!
		expect(reader.id).toBe('read_skill')
		expect(reader.implementationKind).toBe('read-skill')
		expect(Object.isFrozen(reader)).toBe(true)
		await expect(reader.invokeValidated(undefined, { skill: 'demo', path: 'notes.txt' })).resolves.toEqual({ skill: 'demo', path: 'notes.txt', content: 'snapshot one' })
		expect(await reader.input['~standard'].validate({ skill: 'other' })).toHaveProperty('issues')
		expect(() => loaded.demo.readText('../secret')).toThrow(expect.objectContaining({ constructor: SkillManifestError, meta: expect.objectContaining({ reason: 'invalid_skill_path', path: '../secret' }) }))
	})

	it('validates strict current frontmatter without exposing file contents', async () => {
		const definition = await skill('demo', 'SECRET_BODY', 'unknown: field\n')
		let caught: unknown
		try { await loadSkillSnapshots([definition]) } catch (error) { caught = error }
		expect(caught).toBeInstanceOf(SkillManifestError)
		expect(caught).toMatchObject({ meta: { reason: 'invalid_frontmatter', skill_id: 'demo', path: 'SKILL.md' } })
		expect(String(caught)).not.toContain('SECRET_BODY')
	})

	it('rejects non-file URLs, symlink roots, invalid UTF-8, and cancellation', async () => {
		await expect(loadSkillSnapshots([defineSkill('remote', { directory: new URL('https://example.test/skill') })])).rejects.toMatchObject({ meta: { reason: 'invalid_skill_url' } })
		const definition = await skill('demo')
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h4-link-')); roots.push(root)
		const link = path.join(root, 'demo'); await fs.symlink(new URL(definition.directory), link)
		await expect(loadSkillSnapshots([defineSkill('demo', { directory: pathToFileURL(link) })])).rejects.toMatchObject({ meta: { reason: 'unsafe_skill_entry' } })
		await fs.writeFile(path.join(new URL(definition.directory).pathname, 'SKILL.md'), new Uint8Array([0xff, 0xfe]))
		await expect(loadSkillSnapshots([definition])).rejects.toMatchObject({ meta: { reason: 'invalid_skill_encoding' } })
		const controller = new AbortController(); controller.abort('caller detail')
		await expect(loadSkillSnapshots([definition], controller.signal)).rejects.toBeInstanceOf(OperationCancelledError)
	})

	it('rejects Skill allocation limits from lstat metadata before reading file contents', async () => {
		const oversizedManifestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'h4-large-manifest-')); roots.push(oversizedManifestRoot)
		const oversizedManifestDirectory = path.join(oversizedManifestRoot, 'demo')
		await fs.mkdir(oversizedManifestDirectory)
		await fs.writeFile(path.join(oversizedManifestDirectory, 'SKILL.md'), new Uint8Array(256 * 1024 + 1))
		const manifestRead = vi.spyOn(fs, 'readFile')
		await expect(loadSkillSnapshots([defineSkill('demo', { directory: pathToFileURL(oversizedManifestDirectory) })])).rejects.toMatchObject({ meta: { reason: 'skill_file_too_large', path: 'SKILL.md' } })
		expect(manifestRead).not.toHaveBeenCalled()
		manifestRead.mockRestore()

		const oversizedSkillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'h4-large-skill-')); roots.push(oversizedSkillRoot)
		const oversizedSkillDirectory = path.join(oversizedSkillRoot, 'large')
		await fs.mkdir(oversizedSkillDirectory)
		const file = await fs.open(path.join(oversizedSkillDirectory, '00-large.bin'), 'w')
		try { await file.truncate(100 * 1024 * 1024 + 1) } finally { await file.close() }
		await fs.writeFile(path.join(oversizedSkillDirectory, 'SKILL.md'), '---\nname: large\ndescription: Large fixture.\n---\n')
		const totalRead = vi.spyOn(fs, 'readFile')
		await expect(loadSkillSnapshots([defineSkill('large', { directory: pathToFileURL(oversizedSkillDirectory) })])).rejects.toMatchObject({ meta: { reason: 'scan_limit_reached', path: '00-large.bin' } })
		expect(totalRead).not.toHaveBeenCalled()
	})

	it('keeps guidance-only Skills unmounted and enforces runtime Skill immutability through APIs and child commands', async () => {
		const guidance = await skill('guide')
		const loadedGuide = await loadSkillSnapshots([guidance])
		const memorySession = await open(inMemorySandbox())
		await loadedGuide.guide.mountReadOnly(memorySession)
		expect(await memorySession.exists('/skills/guide/SKILL.md')).toBe(false)

		const base = await skill('demo')
		const runtimeDefinition = defineSkill('demo', { directory: base.directory, runtimes: ['shell'] as const })
		const loaded = await loadSkillSnapshots([runtimeDefinition])
		const unsupported = new Proxy(memorySession, { get(target, property, receiver) { return property === 'mountReadOnly' ? undefined : Reflect.get(target, property, receiver) } })
		await expect(loaded.demo.mountReadOnly(unsupported)).rejects.toMatchObject({ meta: { reason: 'readonly_mount_unsupported' } })
		const session = await open(bashSandbox())
		await loaded.demo.mountReadOnly(session)
		await expect(session.write('/skills/demo/notes.txt', 'changed')).rejects.toBeInstanceOf(Error)
		await expect(session.remove('/skills/demo', { recursive: true })).rejects.toBeInstanceOf(Error)
		await expect(session.mount(new Map([['other', 'x']]), '/skills')).rejects.toBeInstanceOf(Error)
		await expect(session.exec("printf changed > /skills/demo/notes.txt")).rejects.toBeInstanceOf(Error)
		expect(await session.readText('/skills/demo/notes.txt')).toBe('snapshot one')
	})

	it('publishes explicit frozen runtime metadata and rejects inference-prone configurations', async () => {
		const fake = new FakeSandbox({ runtimes: ['shell', 'python'] })
		expect(fake.runtimes).toEqual(['python', 'shell'])
		expect(Object.isFrozen(fake.runtimes)).toBe(true)
		expect(() => new FakeSandbox({ executor: 'unavailable', runtimes: ['python'] })).toThrow()
		expect(() => new FakeSandbox({ runtimes: ['shell', 'shell'] })).toThrow()
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'h4-local-')); roots.push(root)
		expect(() => localDirectorySandbox({ root, runtimes: ['python'] })).toThrow()
		const local = localDirectorySandbox({ root, exec: {}, runtimes: ['python'] })
		expect(local.runtimes).toEqual(['python'])
		expect(local.capabilities).not.toContain('sandbox.readonly_mount')
		expect(inMemorySandbox().runtimes).toEqual([])
		expect(bashSandbox().runtimes).toEqual(['shell'])
		expect(bashSandbox({ python: true }).runtimes).toEqual(['python', 'shell'])
	})
})
