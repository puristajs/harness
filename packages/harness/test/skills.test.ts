import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import { defineHarness, discoverSkills } from '../src/index.js'
import { loadSkills, mountSkillsOnce } from '../src/skills/index.js'
import { SkillManifestError } from '../src/errors/index.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function makeSkill(root: string, name: string, frontmatter?: string, body = 'Use this skill for tests.') {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    frontmatter ?? `---\nname: ${name}\ndescription: Use this skill when testing skill activation.\n---\n${body}`,
  )
  return dir
}

it('parses strict SKILL.md YAML frontmatter and preserves optional fields', async () => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(
    root,
    'demo-skill',
    `---
name: demo-skill
description: |
  Use this skill when tests need a realistic skill fixture.
license: Apache-2.0
compatibility: Works with PURISTA harness tests.
allowed-tools: read, bash
metadata:
  owner: qa
---
body`,
  )

  const skills = await loadSkills({ 'demo-skill': { directory: dir } })
  expect(skills['demo-skill']).toMatchObject({
    name: 'demo-skill',
    description: 'Use this skill when tests need a realistic skill fixture.',
    license: 'Apache-2.0',
    compatibility: 'Works with PURISTA harness tests.',
    allowedTools: 'read, bash',
    metadata: { owner: 'qa' },
    mountPath: '/skills/demo-skill',
    trust: 'trusted',
  })
  expect(skills['demo-skill'].location).toBe(path.join(dir, 'SKILL.md'))
})

it('rejects invalid strict frontmatter without exposing skill body content', async () => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(
    root,
    'bad-skill',
    `---
name: Bad Skill
description: Use this invalid skill when testing failures.
---
SECRET_SKILL_BODY`,
  )

  await expect(loadSkills({ 'bad-skill': { directory: dir } })).rejects.toBeInstanceOf(SkillManifestError)
  await expect(loadSkills({ 'bad-skill': { directory: dir } })).rejects.not.toThrow('SECRET_SKILL_BODY')
})

it('supports lenient scalar repair and reports diagnostics', async () => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(
    root,
    'lenient-skill',
    `---
name: lenient-skill
description: Use this skill when: scalar values contain colons
---
body`,
  )

  const skills = await loadSkills({ 'lenient-skill': { directory: dir, validationMode: 'lenient' } })
  expect(skills['lenient-skill'].description).toBe('Use this skill when: scalar values contain colons')
  expect(
    skills['lenient-skill'].diagnostics.some((item) => item.code === 'invalid_frontmatter' && item.level === 'warn'),
  ).toBe(true)
})

it('discovers trusted project skills and skips untrusted project roots', async () => {
  const projectRoot = await makeTempRoot('project-skills-')
  const dir = await makeSkill(path.join(projectRoot, '.agents', 'skills'), 'incident-skill')

  const untrusted = await discoverSkills({ projectRoot, includeProjectAgentsDir: true })
  expect(untrusted.skills['incident-skill']).toBeUndefined()
  expect(untrusted.diagnostics.some((item) => item.code === 'untrusted_project_skill')).toBe(true)

  const trusted = await discoverSkills({
    projectRoot,
    trustedProjectRoots: [projectRoot],
    includeProjectAgentsDir: true,
  })
  expect(trusted.skills['incident-skill']?.directory).toBe(dir)
})

it('reports discovery collisions without merging skill directories', async () => {
  const projectRoot = await makeTempRoot('project-skills-')
  await makeSkill(path.join(projectRoot, '.agents', 'skills'), 'shared-skill')
  await makeSkill(path.join(projectRoot, '.codex', 'skills'), 'shared-skill')

  const discovered = await discoverSkills({
    projectRoot,
    clientName: 'codex',
    trustedProjectRoots: [projectRoot],
    includeProjectAgentsDir: true,
    includeProjectClientDir: true,
  })

  expect(discovered.skills['shared-skill']).toBeDefined()
  expect(discovered.diagnostics.some((item) => item.code === 'collision_shadowed')).toBe(true)
})

it('mounts skill directories once per session without executing bundled scripts', async () => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(root, 'example-skill')
  await fs.mkdir(path.join(dir, 'scripts'))
  await fs.writeFile(path.join(dir, 'scripts', 'run.sh'), 'touch /script-was-executed')
  const skills = await loadSkills({ 'example-skill': { directory: dir } })
  const adapter = inMemorySandbox()
  const scope = {
    owner: { namespace: 'skills-test', id: 's', instanceId: '01J00000000000000000000000' },
    partition: { kind: 'shared' as const },
    lifetime: 'run' as const,
    runId: 'r',
  }
  await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
  const session = (await adapter.open({ scope, mode: 'create' })).session
  const mounted = new Set<string>()

  await mountSkillsOnce(session, mounted, skills, ['example-skill'])
  await mountSkillsOnce(session, mounted, skills, ['example-skill'])

  expect(await session.readText('/skills/example-skill/SKILL.md')).toContain('name: example-skill')
  expect(await session.readText('/skills/example-skill/scripts/run.sh')).toBe('touch /script-was-executed')
  expect(await session.exists('/script-was-executed')).toBe(false)
  expect(mounted).toEqual(new Set(['example-skill']))
})

it('runs a direct harness agent through compact catalog and read-tool activation', async () => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(root, 'answer-skill', undefined, 'Always answer with "skill used".')
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'read-skill', name: 'read', arguments: { path: '/skills/answer-skill/SKILL.md' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({
    object: 'skill used',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .skills({ 'answer-skill': { directory: dir } })
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Use relevant skills.',
      skills: ['answer-skill'],
      builtinTools: ['read'],
    })
    .build()

  const session = await harness.getSession('s1')
  await expect(session.agents.a1.run('hello')).resolves.toMatchObject({ status: 'completed', output: 'skill used' })
  expect(model.requests[0]?.messages?.[0]?.content).toContain('Location: /skills/answer-skill/SKILL.md')
  expect(model.requests[0]?.messages?.[0]?.content).not.toContain('Always answer')
})

it.each([
  { label: 'omits builtinTools', builtinTools: undefined },
  { label: 'sets builtinTools to false', builtinTools: false as const },
])('fails during agent registration when a default-loop skill agent $label', async ({ builtinTools }) => {
  const root = await makeTempRoot('skills-')
  const dir = await makeSkill(root, 'read-required')
  const model = new FakeModelProvider()

  expect(() =>
    defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .skills({ 'read-required': { directory: dir } })
      .agent('a1', {
        model: 'fast',
        output: z.string(),
        instructions: 'x',
        skills: ['read-required'],
        ...(builtinTools === undefined ? {} : { builtinTools }),
      }),
  ).toThrow(
    expect.objectContaining({
      constructor: SkillManifestError,
      meta: { reason: 'skill_read_tool_missing', agent_id: 'a1' },
    }),
  )
  expect(model.requests).toHaveLength(0)
})
