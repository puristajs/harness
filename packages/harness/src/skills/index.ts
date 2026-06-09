import fs from 'node:fs'
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { SkillManifestError, SkillNotFoundError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type {
  DiscoveredSkills,
  DiscoverSkillsOptions,
  ResolvedSkill,
  SkillDefinition,
  SkillDiagnostic,
  SkillFrontmatter,
  SkillValidationMode
} from '../harness/defineHarness.js'
import type { SandboxSession } from '../sandbox/index.js'

const skillNamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.astro'])

type ParsedSkill = {
  frontmatter: SkillFrontmatter
  diagnostics: SkillDiagnostic[]
}

function diagnostic(
  code: SkillDiagnostic['code'],
  message: string,
  opts: { level?: SkillDiagnostic['level']; skillName?: string | undefined; directory?: string | undefined; source?: string | undefined } = {}
): SkillDiagnostic {
  return {
    level: opts.level ?? 'error',
    code,
    message,
    ...(opts.skillName ? { skillName: opts.skillName } : {}),
    ...(opts.directory ? { directory: opts.directory } : {}),
    ...(opts.source ? { source: opts.source } : {})
  }
}

function throwManifest(diag: SkillDiagnostic, skillId?: string, cause?: unknown): never {
  throw new SkillManifestError(diag.message, {
    reason: diag.code,
    directory: diag.directory ?? '',
    ...(skillId ? { skill_id: skillId } : {}),
    ...(diag.source ? { source: diag.source } : {})
  }, cause)
}

function extractFrontmatter(content: string, directory: string): string {
  if (!content.startsWith('---\n')) {
    throwManifest(diagnostic('invalid_frontmatter', 'SKILL.md must start with YAML frontmatter.', { directory }))
  }
  const end = content.indexOf('\n---', 4)
  if (end < 0) {
    throwManifest(diagnostic('invalid_frontmatter', 'SKILL.md frontmatter is not terminated.', { directory }))
  }
  return content.slice(4, end)
}

function quoteColonScalars(raw: string): string {
  return raw.split('\n').map((line) => {
    const match = /^([A-Za-z0-9_-]+):\s*(.+:.+)$/.exec(line)
    if (!match) return line
    const key = match[1] ?? ''
    const value = match[2] ?? ''
    const trimmed = value.trim()
    if (
      trimmed.startsWith('"')
      || trimmed.startsWith("'")
      || trimmed.startsWith('|')
      || trimmed.startsWith('>')
      || trimmed.startsWith('{')
      || trimmed.startsWith('[')
    ) {
      return line
    }
    return `${key}: ${JSON.stringify(trimmed)}`
  }).join('\n')
}

function parseYamlFrontmatter(raw: string, mode: SkillValidationMode, directory: string): { value: unknown; diagnostics: SkillDiagnostic[] } {
  const first = parseDocument(raw, { strict: true })
  if (!first.errors.length) return { value: first.toJSON(), diagnostics: [] }
  if (mode === 'lenient') {
    const retried = parseDocument(quoteColonScalars(raw), { strict: true })
    if (!retried.errors.length) {
      return {
        value: retried.toJSON(),
        diagnostics: [diagnostic('invalid_frontmatter', 'Lenient skill parsing repaired YAML scalar quoting.', { level: 'warn', directory })]
      }
    }
  }
  throwManifest(diagnostic('invalid_frontmatter', 'Invalid SKILL.md YAML frontmatter.', { directory }), undefined, first.errors[0])
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validateFrontmatter(value: unknown, mode: SkillValidationMode, directory: string, expectedName?: string, source?: string): ParsedSkill | undefined {
  const data = asRecord(value)
  const diagnostics: SkillDiagnostic[] = []
  const nameValue = data['name']
  const name = typeof nameValue === 'string' ? nameValue.trim() : ''
  if (!skillNamePattern.test(name)) {
    const diag = diagnostic('invalid_name', 'Skill name must be 1-64 lowercase ASCII letters, numbers, or hyphens with no leading, trailing, or consecutive hyphens.', { directory, source, skillName: name })
    if (mode === 'strict') throwManifest(diag, expectedName)
    diagnostics.push(diag)
    return undefined
  }

  const descriptionValue = data['description']
  const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : ''
  if (description.length < 1 || description.length > 1024) {
    const diag = diagnostic('missing_description', 'Skill description is required and must be 1-1024 characters.', { directory, source, skillName: name })
    if (mode === 'strict') throwManifest(diag, expectedName)
    diagnostics.push(diag)
    return undefined
  }

  const parentName = path.basename(directory)
  if (expectedName && expectedName !== name) {
    const diag = diagnostic('name_mismatch', `Skill key "${expectedName}" must match frontmatter name "${name}".`, { directory, source, skillName: name, level: mode === 'strict' ? 'error' : 'warn' })
    if (mode === 'strict') throwManifest(diag, expectedName)
    diagnostics.push(diag)
  } else if (!expectedName && parentName !== name) {
    const diag = diagnostic('name_mismatch', `Skill directory "${parentName}" does not match frontmatter name "${name}".`, { directory, source, skillName: name, level: mode === 'strict' ? 'error' : 'warn' })
    if (mode === 'strict') throwManifest(diag, name)
    diagnostics.push(diag)
  }

  const metadata = asRecord(data['metadata'])
  const metadataOut: Record<string, string> = {}
  for (const [key, val] of Object.entries(metadata)) {
    if (typeof val === 'string') metadataOut[key] = val
  }

  return {
    frontmatter: {
      name,
      description,
      ...(typeof data['license'] === 'string' && data['license'].trim() ? { license: data['license'].trim() } : {}),
      ...(typeof data['compatibility'] === 'string' && data['compatibility'].trim() ? { compatibility: data['compatibility'].trim() } : {}),
      ...(Object.keys(metadataOut).length ? { metadata: metadataOut } : {}),
      ...(typeof data['allowed-tools'] === 'string' && data['allowed-tools'].trim() ? { 'allowed-tools': data['allowed-tools'].trim() } : {})
    },
    diagnostics
  }
}

function readSkill(directory: string, mode: SkillValidationMode, expectedName?: string, source?: string): ResolvedSkill | undefined {
  const stat = fs.existsSync(directory) ? fs.statSync(directory) : null
  if (!stat?.isDirectory()) {
    const diag = diagnostic('directory_missing', 'Skill directory is missing.', { directory, source, skillName: expectedName })
    if (mode === 'strict') throwManifest(diag, expectedName)
    return undefined
  }
  const skillPath = path.resolve(directory, 'SKILL.md')
  if (!fs.existsSync(skillPath)) {
    const diag = diagnostic('missing_skill_md', 'Skill directory must contain SKILL.md.', { directory, source, skillName: expectedName })
    if (mode === 'strict') throwManifest(diag, expectedName)
    return undefined
  }
  const content = fs.readFileSync(skillPath, 'utf8')
  const raw = extractFrontmatter(content, directory)
  const parsed = parseYamlFrontmatter(raw, mode, directory)
  const checked = validateFrontmatter(parsed.value, mode, directory, expectedName, source)
  if (!checked) return undefined
  const frontmatter = checked.frontmatter
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    directory: path.resolve(directory),
    skillPath,
    location: skillPath,
    mountPath: `/skills/${frontmatter.name}`,
    ...(frontmatter.license ? { license: frontmatter.license } : {}),
    ...(frontmatter.compatibility ? { compatibility: frontmatter.compatibility } : {}),
    ...(frontmatter.metadata ? { metadata: frontmatter.metadata } : {}),
    ...(frontmatter['allowed-tools'] ? { allowedTools: frontmatter['allowed-tools'] } : {}),
    trust: 'trusted',
    ...(source ? { source } : {}),
    diagnostics: [...parsed.diagnostics, ...checked.diagnostics]
  }
}

export function loadSkillsSync(skills: Record<string, SkillDefinition>): Record<string, ResolvedSkill> {
  const resolved: Record<string, ResolvedSkill> = {}
  for (const [key, def] of Object.entries(skills)) {
    const skill = readSkill(path.resolve(def.directory), def.validationMode ?? 'strict', key, def.source)
    if (!skill) continue
    resolved[key] = {
      ...skill,
      trust: def.trust ?? 'trusted',
      ...(def.source ? { source: def.source } : {})
    }
  }
  return resolved
}

export async function loadSkills(skills: Record<string, SkillDefinition>): Promise<Record<string, ResolvedSkill>> {
  return loadSkillsSync(skills)
}

const SKILL_MOUNT_MAX_FILES = 5_000
const SKILL_MOUNT_MAX_BYTES = 100_000_000

async function readDirRecursive(root: string, skillId: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        if (files.size >= SKILL_MOUNT_MAX_FILES) {
          throw new SkillManifestError('Skill exceeds the mount file-count limit.', { reason: 'scan_limit_reached', skill_id: skillId, directory: root })
        }
        const data = await fsp.readFile(abs)
        totalBytes += data.byteLength
        if (totalBytes > SKILL_MOUNT_MAX_BYTES) {
          throw new SkillManifestError('Skill exceeds the mount byte limit.', { reason: 'scan_limit_reached', skill_id: skillId, directory: root })
        }
        files.set(path.posix.normalize(path.relative(root, abs).split(path.sep).join('/')), data)
      }
    }
  }
  await walk(root)
  return files
}

export async function mountSkillsOnce(
  session: SandboxSession,
  mounted: Set<string>,
  skills: Record<string, ResolvedSkill>,
  skillIds: readonly string[]
): Promise<void> {
  if (skillIds.length > 0 && typeof session.mount !== 'function') {
    throw new SkillManifestError('Sandbox does not support skill mounting.', { reason: 'skill_sandbox_unsupported' })
  }
  for (const skillId of skillIds) {
    if (mounted.has(skillId)) continue
    const skill = skills[skillId]
    if (!skill) throw new SkillNotFoundError('Skill not found.', { skill_id: skillId })
    const files = await readDirRecursive(skill.directory, skillId)
    await session.mount(files, skill.mountPath)
    mounted.add(skillId)
  }
}

export function buildSkillIndex(skills: Record<string, ResolvedSkill>, ids: readonly string[]): string {
  if (ids.length === 0) return ''
  const lines: string[] = ['', '', 'Available skills:']
  for (const id of ids) {
    const skill = skills[id]
    if (!skill) continue
    lines.push(`- ${skill.name}: ${skill.description}`)
    lines.push(`  Location: ${skill.mountPath}/SKILL.md`)
    if (skill.compatibility) lines.push(`  Compatibility: ${skill.compatibility}`)
  }
  lines.push('', 'Use the read tool to load /skills/<name>/SKILL.md when a skill is relevant.')
  lines.push('Relative paths in a skill are relative to /skills/<name>/.')
  return lines.join('\n')
}

function shouldSkipDirectory(name: string, clientName?: string): boolean {
  if (skippedDirectories.has(name)) return true
  if (!name.startsWith('.')) return false
  return name !== '.agents' && name !== '.claude' && (clientName ? name !== `.${clientName}` : true)
}

async function findSkillDirectories(root: string, opts: { maxDepth: number; maxDirectories: number; clientName?: string | undefined; diagnostics: SkillDiagnostic[] }): Promise<string[]> {
  const out: string[] = []
  let visited = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited >= opts.maxDirectories) {
      opts.diagnostics.push(diagnostic('scan_limit_reached', 'Skill discovery directory limit reached.', { directory: dir }))
      return
    }
    visited += 1
    if (depth > opts.maxDepth) return
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      out.push(dir)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name, opts.clientName)) continue
      await walk(path.join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

function addSkillConfig(target: SkillsConfigBuilder, name: string, def: SkillDefinition, diagnostics: SkillDiagnostic[]): void {
  if (target[name]) {
    diagnostics.push(diagnostic('collision_shadowed', `Skill "${name}" was shadowed by a higher-precedence binding.`, { level: 'warn', skillName: name, directory: def.directory, source: def.source }))
    return
  }
  target[name] = def
}

type SkillsConfigBuilder = Record<string, SkillDefinition>

export async function discoverSkills(options: DiscoverSkillsOptions = {}): Promise<DiscoveredSkills> {
  const diagnostics: SkillDiagnostic[] = []
  const skills: SkillsConfigBuilder = {}
  const validationMode = options.validationMode ?? 'lenient'
  const maxDepth = options.maxDepth ?? 6
  const maxDirectories = options.maxDirectories ?? 2000
  const trustedRoots = new Set((options.trustedProjectRoots ?? []).map((root) => path.resolve(root)))
  const projectRoot = path.resolve(options.projectRoot ?? process.env['PWD'] ?? '.')
  const roots: Array<{ root: string; trust: 'project' | 'user'; source: string; trusted: boolean }> = []

  if (options.includeUserAgentsDir) roots.push({ root: path.join(os.homedir(), '.agents', 'skills'), trust: 'user', source: 'user_agents', trusted: true })
  if (options.includeUserClientDir && options.clientName) roots.push({ root: path.join(os.homedir(), `.${options.clientName}`, 'skills'), trust: 'user', source: 'user_client', trusted: true })
  if (options.includeProjectAgentsDir ?? true) roots.push({ root: path.join(projectRoot, '.agents', 'skills'), trust: 'project', source: 'project_agents', trusted: trustedRoots.has(projectRoot) })
  if (options.includeProjectClientDir && options.clientName) roots.push({ root: path.join(projectRoot, `.${options.clientName}`, 'skills'), trust: 'project', source: 'project_client', trusted: trustedRoots.has(projectRoot) })
  if (options.includeClaudeCompatDir) roots.push({ root: path.join(projectRoot, '.claude', 'skills'), trust: 'project', source: 'project_claude', trusted: trustedRoots.has(projectRoot) })

  for (const rootInfo of roots) {
    if (!fs.existsSync(rootInfo.root)) continue
    if (rootInfo.trust === 'project' && !rootInfo.trusted) {
      diagnostics.push(diagnostic('untrusted_project_skill', 'Project skill discovery root is not trusted.', { level: 'warn', directory: rootInfo.root, source: rootInfo.source }))
      continue
    }
    for (const directory of await findSkillDirectories(rootInfo.root, { maxDepth, maxDirectories, clientName: options.clientName, diagnostics })) {
      const skill = readSkill(directory, validationMode, undefined, rootInfo.source)
      if (!skill) continue
      addSkillConfig(skills, skill.name, { directory, validationMode, trust: rootInfo.trust, source: rootInfo.source }, diagnostics)
      diagnostics.push(...skill.diagnostics)
    }
  }

  return { skills, diagnostics }
}

export function assertSerializable(value: unknown): asserts value is JsonValue {
  try {
    JSON.stringify(value)
  } catch {
    throw new SkillManifestError('Non-serializable value', { reason: 'invalid_frontmatter', directory: '' })
  }
}
