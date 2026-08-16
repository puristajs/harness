import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  AgentPluginLoadError,
  AgentPluginManifestError,
  AgentPluginTrustError,
  inspectAgentPlugin,
  inspectAgentPluginSync,
  isPathContained,
  loadAgentPlugins
} from '../src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function pluginRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-plugins-'))
  roots.push(root)
  return root
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')
}

function writeSkill(root: string, directory: string, name = directory, description = 'A valid test skill.'): void {
  const skillPath = path.join(root, 'skills', directory, 'SKILL.md')
  fs.mkdirSync(path.dirname(skillPath), { recursive: true })
  fs.writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
}

function writeManifest(root: string, extra: Record<string, unknown> = {}): void {
  writeJson(path.join(root, 'plugin.json'), {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: 'acme.research',
    ...extra
  })
}

describe('Agent Plugins v1 inspector', () => {
  it('discovers immediate valid skills, redacts source paths, and creates explicit core bindings', async () => {
    const root = pluginRoot()
    writeManifest(root, { version: '1.2.3', extensions: { 'com.example.client': { ignored: true } } })
    writeSkill(root, 'research')
    writeSkill(root, path.join('nested', 'not-discovered'), 'not-discovered')
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['--data', '${PLUGIN_DATA}/state'],
          env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          cwd: '${PLUGIN_ROOT}'
        },
        remote: {
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          headers: { 'X-Public-Tenant': 'acme' }
        }
      }
    })

    const plugin = inspectAgentPluginSync({ root, trust: 'trusted' })

    expect(plugin.valid).toBe(true)
    expect(plugin.manifest).toMatchObject({ name: 'acme.research', version: '1.2.3' })
    expect(plugin.skills).toHaveLength(1)
    expect(plugin.skills[0]).toMatchObject({ name: 'research', description: 'A valid test skill.' })
    expect(plugin.mcpServers).toEqual([
      expect.objectContaining({ name: 'local', transport: 'stdio' }),
      expect.objectContaining({ name: 'remote', transport: 'streamable-http' })
    ])
    expect(JSON.stringify(plugin)).not.toContain(root)

    const [loaded] = await loadAgentPlugins({ plugins: [{ root, trust: 'trusted' }] })
    const bindings = loaded?.bindings({
      skills: { 'acme-research': 'research' },
      tools: { search_docs: { server: 'remote', tool: 'search', description: 'Search approved documents.' } }
    })
    expect(bindings?.diagnostics).toEqual([])
    expect(bindings?.skills['acme-research']).toMatchObject({ trust: 'trusted', source: 'agent_plugin:acme.research' })
    expect(bindings?.tools['search_docs']).toMatchObject({ kind: 'mcp_http', tool: 'search', url: 'https://example.test/mcp' })
    expect(bindings?.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'skill', componentName: 'research' }),
      expect.objectContaining({ component: 'mcp', componentName: 'remote', transport: 'streamable-http' })
    ]))
  })

  it('reports unknown manifest fields but keeps an otherwise valid plugin loadable', () => {
    const root = pluginRoot()
    writeManifest(root, { unsupported: true, extensions: 'not-an-object' })

    const plugin = inspectAgentPluginSync({ root })

    expect(plugin.valid).toBe(true)
    expect(plugin.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manifest_unknown_field', level: 'warn', item: 'unsupported' }),
      expect.objectContaining({ code: 'manifest_extensions_ignored', level: 'warn' })
    ]))
  })

  it('rejects an invalid manifest before discovering its components', () => {
    const root = pluginRoot()
    writeJson(path.join(root, 'plugin.json'), { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'Invalid_Name' })
    writeSkill(root, 'research')

    const plugin = inspectAgentPluginSync({ root })

    expect(plugin.valid).toBe(false)
    expect(plugin.skills).toEqual([])
    expect(plugin.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'manifest_invalid' })]))
  })

  it('isolates malformed skills and malformed individual MCP entries', () => {
    const root = pluginRoot()
    writeManifest(root)
    writeSkill(root, 'valid')
    const invalidPath = path.join(root, 'skills', 'invalid', 'SKILL.md')
    fs.mkdirSync(path.dirname(invalidPath), { recursive: true })
    fs.writeFileSync(invalidPath, '# no frontmatter', 'utf8')
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        escapes: { type: 'stdio', command: '../escape' },
        insecure: { type: 'streamable-http', url: 'http://example.test/mcp' },
        valid: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' }
      }
    })

    const plugin = inspectAgentPluginSync({ root })

    expect(plugin.valid).toBe(true)
    expect(plugin.skills.map((skill) => skill.name)).toEqual(['valid'])
    expect(plugin.mcpServers).toEqual([expect.objectContaining({ name: 'valid', transport: 'streamable-http' })])
    expect(plugin.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'skill_invalid', item: 'invalid' }),
      expect.objectContaining({ code: 'server_invalid', item: 'escapes' }),
      expect.objectContaining({ code: 'server_invalid', item: 'insecure' })
    ]))
  })

  it('rejects resolved paths that escape through symlinks while preserving other components', () => {
    const root = pluginRoot()
    const outside = pluginRoot()
    writeManifest(root)
    writeSkill(outside, 'outside')
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'skills', 'outside'), path.join(root, 'skills', 'linked'), 'dir')
    writeJson(path.join(root, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {} })

    const plugin = inspectAgentPluginSync({ root })

    expect(plugin.valid).toBe(true)
    expect(plugin.skills).toEqual([])
    expect(plugin.mcpServers).toEqual([])
    expect(plugin.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'path_escape', item: 'linked' })]))
  })

  it('uses path-relative containment correctly for Windows and POSIX semantics', () => {
    expect(isPathContained('C:\\plugins\\acme', 'C:\\plugins\\acme\\skills\\research', path.win32)).toBe(true)
    expect(isPathContained('C:\\plugins\\acme', 'C:\\plugins\\acme-other\\SKILL.md', path.win32)).toBe(false)
    expect(isPathContained('C:\\plugins\\acme', 'D:\\plugins\\acme\\SKILL.md', path.win32)).toBe(false)
    expect(isPathContained('/plugins/acme', '/plugins/acme/skills/research', path.posix)).toBe(true)
    expect(isPathContained('/plugins/acme', '/plugins/acme-other/SKILL.md', path.posix)).toBe(false)
  })

  it('requires explicit trust, accepts trusted roots, and rejects a digest mismatch without binding', async () => {
    const root = pluginRoot()
    writeManifest(root)
    writeSkill(root, 'research')

    await expect(loadAgentPlugins({ plugins: [{ root }] })).resolves.toEqual([])
    const trustedByRoot = await loadAgentPlugins({ plugins: [{ root }], trustedRoots: [path.dirname(root)] })
    expect(trustedByRoot).toHaveLength(1)
    const inspection = inspectAgentPluginSync({ root, trust: 'trusted' })
    expect(inspection.digest).toMatch(/^[a-f0-9]{64}$/)
    const digest = inspection.digest
    if (!digest) throw new Error('Expected a plugin digest.')
    await expect(loadAgentPlugins({ plugins: [{ root, trust: 'trusted', expectedDigest: '0'.repeat(64) }] })).resolves.toEqual([])
    await expect(loadAgentPlugins({ plugins: [{ root, trust: 'trusted', expectedDigest: digest }] })).resolves.toHaveLength(1)
  })

  it('reports legacy SSE as unsupported and never materializes it as a harness tool', async () => {
    const root = pluginRoot()
    writeManifest(root)
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { legacy: { type: 'sse', url: 'https://legacy.example.test/sse' } }
    })

    const inspection = inspectAgentPluginSync({ root, trust: 'trusted' })
    expect(inspection.mcpServers).toEqual([])
    expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'transport_unsupported', item: 'legacy' })]))
    const [loaded] = await loadAgentPlugins({ plugins: [{ root, trust: 'trusted' }] })
    expect(loaded?.bindings({ tools: { legacy_tool: { server: 'legacy', tool: 'search', description: 'Legacy.' } } }).tools).toEqual({})
  })

  it('covers explicit selection diagnostics and both current harness MCP projections', async () => {
    const root = pluginRoot()
    const dataDirectory = path.join(root, '.data')
    fs.mkdirSync(dataDirectory, { recursive: true })
    fs.writeFileSync(path.join(dataDirectory, 'state.txt'), 'before', 'utf8')
    writeManifest(root)
    writeSkill(root, 'research')
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: { type: 'stdio', command: './bin/server', args: ['--safe'], env: { SAFE: 'yes' }, cwd: './' },
        remote: { type: 'streamable-http', url: 'https://example.test/mcp' }
      }
    })
    const [loaded] = await loadAgentPlugins({ plugins: [{ root, trust: 'trusted', dataDirectory }], supportedTransports: ['stdio'] })
    const bindings = loaded?.bindings({
      skills: { Bad_Alias: 'research', missing: 'missing' },
      tools: {
        bad_alias: { server: 'local', tool: '', description: '' },
        local_tool: { server: 'local', tool: 'validate', description: 'Validate.' },
        remote_tool: { server: 'remote', tool: 'search', description: 'Search.' },
        missing_server: { server: 'missing', tool: 'search', description: 'Search.' }
      }
    })
    expect(bindings?.tools['local_tool']).toMatchObject({ kind: 'mcp_stdio', command: './bin/server', cwd: './' })
    expect(bindings?.tools['remote_tool']).toBeUndefined()
    expect(bindings?.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['skill_invalid', 'server_invalid', 'transport_unsupported']))
    await expect(inspectAgentPlugin({ root, trust: 'trusted' })).resolves.toMatchObject({ valid: true })
    expect(new AgentPluginManifestError('bad manifest').name).toBe('AgentPluginManifestError')
    expect(new AgentPluginTrustError('untrusted').name).toBe('AgentPluginTrustError')
    expect(new AgentPluginLoadError('bad binding').name).toBe('AgentPluginLoadError')
  })

  it('stages a reviewed stdio plugin and synchronizes only sandbox data through cleanup', async () => {
    const root = pluginRoot()
    const dataDirectory = path.join(root, '.data')
    fs.mkdirSync(dataDirectory, { recursive: true })
    fs.writeFileSync(path.join(dataDirectory, 'state.txt'), 'before', 'utf8')
    writeManifest(root)
    writeJson(path.join(root, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['--root=${PLUGIN_ROOT}', '--data=${PLUGIN_DATA}'],
          env: { CONFIG: '${PLUGIN_DATA}/state.txt' },
          cwd: '${PLUGIN_DATA}'
        }
      }
    })
    const [loaded] = await loadAgentPlugins({ plugins: [{ root, trust: 'trusted', dataDirectory }] })
    const tool = loaded?.bindings({ tools: { local_tool: { server: 'local', tool: 'validate', description: 'Validate.' } } }).tools['local_tool']
    if (!tool || tool.kind !== 'mcp_stdio' || !tool.prepareLaunch) throw new Error('Expected a staged stdio tool.')

    const virtualFiles = new Map<string, Uint8Array | string>()
    const sandbox = {
      executor: 'available' as const,
      async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string) {
        for (const [relative, value] of files) virtualFiles.set(`${atPath}/${relative}`, value)
      },
      async list(directory: string) {
        return [...virtualFiles.keys()]
          .filter((filePath) => filePath.startsWith(`${directory}/`))
          .map((filePath) => ({ path: filePath, kind: 'file' }))
      },
      async read(filePath: string) {
        const value = virtualFiles.get(filePath)
        if (value === undefined) throw new Error('Missing virtual file.')
        return typeof value === 'string' ? new TextEncoder().encode(value) : value
      }
    }
    const prepared = await tool.prepareLaunch({ sandbox: sandbox as never })
    const rootPath = `/plugins/${loaded?.inspection.digest}/root`
    const dataPath = `/plugins/${loaded?.inspection.digest}/data`
    expect(prepared).toMatchObject({
      command: `${rootPath}/bin/server`,
      args: [`--root=${rootPath}`, `--data=${dataPath}`],
      cwd: dataPath,
      env: { CONFIG: `${dataPath}/state.txt`, PLUGIN_ROOT: rootPath, PLUGIN_DATA: dataPath }
    })
    expect(virtualFiles.get(`${rootPath}/plugin.json`)).toBeDefined()
    expect(virtualFiles.get(`${dataPath}/state.txt`)).toBeDefined()
    virtualFiles.set(`${dataPath}/result.txt`, 'after')
    await prepared.cleanup?.()
    expect(fs.readFileSync(path.join(dataDirectory, 'result.txt'), 'utf8')).toBe('after')
  })

  it('isolates manifest and MCP schema/configuration violations without evaluating package code', () => {
    const invalidManifests: unknown[] = [
      [],
      { $schema: 'https://unsupported.example/schema.json', name: 'plugin' },
      { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'plugin', version: 1 },
      { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'plugin', author: { role: 'nope' } },
      { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: 'plugin', keywords: [1] }
    ]
    for (const manifest of invalidManifests) {
      const root = pluginRoot()
      writeJson(path.join(root, 'plugin.json'), manifest)
      expect(inspectAgentPluginSync({ root }).valid).toBe(false)
    }

    const invalidMcp: unknown[] = [
      [],
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: [], extra: true },
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { no_type: {} } },
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { bad_stdio: { type: 'stdio', command: 'shell command' } } },
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { reserved: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'bad' } } } },
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { bad_cwd: { type: 'stdio', command: 'node', cwd: '../bad' } } },
      { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { bad_http: { type: 'streamable-http', url: 'https://user:pass@example.test/#fragment' } } }
    ]
    for (const mcp of invalidMcp) {
      const root = pluginRoot()
      writeManifest(root)
      writeJson(path.join(root, 'mcp.json'), mcp)
      const inspection = inspectAgentPluginSync({ root })
      expect(inspection.valid).toBe(true)
      expect(inspection.mcpServers).toEqual([])
    }
  })

  it('handles invalid skill values and remaining MCP boundary cases', () => {
    const root = pluginRoot()
    writeManifest(root)
    writeSkill(root, 'invalid-name', 'INVALID')
    writeJson(path.join(root, 'mcp.json'), { $schema: AGENT_PLUGIN_MCP_SCHEMA })
    expect(inspectAgentPluginSync({ root }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'skill_invalid', item: 'invalid-name' }),
      expect.objectContaining({ code: 'mcp_config_invalid' })
    ]))

    const rootWithServers = pluginRoot()
    writeManifest(rootWithServers)
    writeJson(path.join(rootWithServers, 'mcp.json'), {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        '': null,
        rooted: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/data' },
        broken_url: { type: 'streamable-http', url: 'not a URL' }
      }
    })
    const inspection = inspectAgentPluginSync({ root: rootWithServers })
    expect(inspection.mcpServers).toEqual([expect.objectContaining({ name: 'rooted', transport: 'stdio' })])
    expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'server_invalid' })]))
  })

  it('enforces caller-configured untrusted file limits before parsing a skill', () => {
    const root = pluginRoot()
    writeManifest(root)
    writeSkill(root, 'research')
    fs.appendFileSync(path.join(root, 'skills', 'research', 'SKILL.md'), 'x'.repeat(1_000), 'utf8')
    const inspection = inspectAgentPluginSync({ root }, { maxFileBytes: 512 })
    expect(inspection.skills).toEqual([])
    expect(inspection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'skill_invalid', item: 'research' })]))
  })

  it('skips an isolated skill with malformed YAML frontmatter', () => {
    const root = pluginRoot()
    writeManifest(root)
    const skillPath = path.join(root, 'skills', 'broken', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, '---\nname: [unterminated\ndescription: Broken\n---\n', 'utf8')
    expect(inspectAgentPluginSync({ root }).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'skill_invalid', item: 'broken' })]))
  })
})
