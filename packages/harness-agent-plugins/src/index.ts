import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type {
  McpHttpToolDefinition,
  McpStdioToolDefinition,
  SkillValidationMode,
  SkillsConfig,
  ToolsConfig
} from '@purista/harness'

/** Canonical Agent Plugins v1 manifest schema identifier. */
export const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/** Canonical Agent Plugins v1 MCP configuration schema identifier. */
export const AGENT_PLUGIN_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const pluginNamePattern = /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/
const skillNamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const prohibitedPluginHeaders = new Set([
  'accept',
  'api-key',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-access-token',
  'x-api-key',
  'x-auth-token'
])

/** A portable Agent Plugins manifest author. */
export interface AgentPluginAuthor {
  name?: string
  email?: string
  url?: string
}

/** The recognized, portable fields in `plugin.json`. */
export interface AgentPluginManifest {
  $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA
  name: string
  version?: string
  description?: string
  author?: AgentPluginAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: readonly string[]
  /** Client-owned data. This package deliberately assigns no semantics to it. */
  extensions?: Record<string, unknown>
}

/** Trust is an explicit application policy decision, never manifest metadata. */
export type AgentPluginTrust = 'trusted' | 'untrusted'

/** Portable MCP transports supported by this clean-major integration. */
export type AgentPluginTransport = 'stdio' | 'streamable-http'

/** One already-installed plugin root to inspect or load. */
export interface AgentPluginSource {
  root: string
  trust?: AgentPluginTrust
  /** Reserved for the core's prepared stdio launch bridge; never created during inspection. */
  dataDirectory?: string
  /** Lowercase SHA-256 package digest previously reviewed by the application, when loading. */
  expectedDigest?: string
}

/**
 * An application-approved plugin source. Loading executable plugin components
 * always requires a digest recorded by the application after review.
 */
export interface ApprovedAgentPluginSource extends AgentPluginSource {
  /** Lowercase SHA-256 package digest previously reviewed by the application. */
  expectedDigest: string
}

/** Options for loading approved plugin roots into explicit application bindings. */
export interface AgentPluginLoadOptions extends InspectAgentPluginOptions {
  plugins: readonly ApprovedAgentPluginSource[]
  trustedRoots?: readonly string[]
  supportedTransports?: readonly AgentPluginTransport[]
  validationMode?: SkillValidationMode
}

/** A caller-selected upstream MCP tool exposed through a local harness alias. */
export interface AgentPluginToolBinding {
  server: string
  tool: string
  description: string
}

/** Content-free skill inventory record safe to expose in inspection output. */
export interface AgentPluginSkill {
  name: string
  description: string
}

/** A validated, declarative MCP stdio server entry. It is not executed by this package. */
interface AgentPluginStdioMcpServer {
  name: string
  type: 'stdio'
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}

/** A validated, declarative MCP Streamable HTTP server entry. */
interface AgentPluginHttpMcpServer {
  name: string
  type: 'streamable-http'
  url: string
  headers?: Readonly<Record<string, string>>
}

/** A validated, declarative MCP server entry. */
type AgentPluginMcpServer = AgentPluginStdioMcpServer | AgentPluginHttpMcpServer

/** Content-free MCP inventory record safe to expose in inspection output. */
export interface AgentPluginMcpServerSummary {
  name: string
  transport: AgentPluginTransport
}

/** Content-free provenance retained alongside each projected component. */
export interface AgentPluginProvenance {
  pluginName: string
  version?: string
  digest: string
  component: 'skill' | 'mcp'
  componentName: string
  transport?: AgentPluginTransport
}

/** One diagnostic emitted while inspecting an untrusted package. No file content is included. */
export interface AgentPluginDiagnostic {
  level: 'warn' | 'error'
  code:
    | 'plugin_root_invalid'
    | 'manifest_missing'
    | 'manifest_invalid'
    | 'manifest_unknown_field'
    | 'manifest_extensions_ignored'
    | 'schema_unsupported'
    | 'path_escape'
    | 'untrusted'
    | 'digest_mismatch'
    | 'component_invalid'
    | 'skill_invalid'
    | 'skill_duplicate'
    | 'mcp_config_invalid'
    | 'transport_unsupported'
    | 'server_invalid'
  message: string
  /** Plugin name when the manifest was valid enough to determine it. */
  pluginName?: string
  /** A component kind, never a source path. */
  component?: 'skills' | 'mcp'
  /** The declared skill or MCP server name when applicable. */
  item?: string
}

/** Result of inspecting a local Agent Plugins v1 package. */
export interface AgentPluginInspection {
  /** `true` only when `plugin.json` is valid and can be used for component discovery. */
  valid: boolean
  manifest?: AgentPluginManifest
  trust: AgentPluginTrust
  /** SHA-256 of the package files when the plugin root could be read safely. */
  digest?: string
  skills: readonly AgentPluginSkill[]
  /** Valid individual MCP server entries without URLs, commands, headers, or environment data. */
  mcpServers: readonly AgentPluginMcpServerSummary[]
  diagnostics: readonly AgentPluginDiagnostic[]
}

/** Local inspection limits and behavior. This package never downloads schemas or executes a plugin. */
export interface InspectAgentPluginOptions {
  /** Maximum bytes read from each JSON manifest or `SKILL.md`. Default: 2 MiB. */
  maxFileBytes?: number
  /** Maximum aggregate bytes hashed while calculating a package digest. Default: 100 MiB. */
  maxPackageBytes?: number
}

/** Normal harness configuration generated from caller-owned literal aliases. */
export interface AgentPluginBindings {
  skills: SkillsConfig
  tools: ToolsConfig
  diagnostics: readonly AgentPluginDiagnostic[]
  provenance: readonly AgentPluginProvenance[]
}

/** An approved plugin retained privately with its resolved source paths. */
export interface LoadedAgentPlugin {
  inspection: AgentPluginInspection
  bindings(options: {
    skills?: Readonly<Record<string, string>>
    tools?: Readonly<Record<string, AgentPluginToolBinding>>
  }): AgentPluginBindings
}

/** Base error for explicit plugin-loading failures. Errors never contain plugin file content. */
export class AgentPluginError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Raised by callers that choose to turn an invalid inspection into an exception. */
export class AgentPluginManifestError extends AgentPluginError {}

/** Raised by callers that choose to turn a denied trust decision into an exception. */
export class AgentPluginTrustError extends AgentPluginError {}

/** Raised when a requested binding cannot be created from an approved plugin. */
export class AgentPluginLoadError extends AgentPluginError {}

type ParsedAgentPluginSkill = AgentPluginSkill & {
  directory: string
  skillPath: string
}

type ParsedAgentPlugin = {
  root: string
  valid: boolean
  manifest?: AgentPluginManifest
  trust: AgentPluginTrust
  digest?: string
  skills: readonly ParsedAgentPluginSkill[]
  mcpServers: readonly AgentPluginMcpServer[]
  diagnostics: readonly AgentPluginDiagnostic[]
}

type PathApi = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>

/**
 * Returns whether `candidate` stays inside `root` after both paths have been
 * resolved with the same platform path implementation. This is exported for
 * host integrations that must apply the same containment rule before use.
 */
export function isPathContained(root: string, candidate: string, pathApi: PathApi = path): boolean {
  const relative = pathApi.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative))
}

/**
 * Inspects one local Agent Plugins v1 directory synchronously.
 *
 * The function reads only package data. It never imports package code, starts
 * an MCP server, expands placeholders, connects to a URL, or fetches schemas.
 */
export function inspectAgentPluginSync(source: AgentPluginSource, options: InspectAgentPluginOptions = {}): AgentPluginInspection {
  return toInspection(parseAgentPluginSync(source, options))
}

/** Async convenience wrapper for {@link inspectAgentPluginSync}. */
export async function inspectAgentPlugin(source: AgentPluginSource, options: InspectAgentPluginOptions = {}): Promise<AgentPluginInspection> {
  return inspectAgentPluginSync(source, options)
}

/**
 * Loads only trusted, valid, locally installed plugins. Invalid, untrusted, or
 * digest-mismatched sources are omitted; call {@link inspectAgentPlugin} first
 * to present their content-free diagnostics to a reviewer.
 */
export async function loadAgentPlugins(options: AgentPluginLoadOptions): Promise<readonly LoadedAgentPlugin[]> {
  const loaded: LoadedAgentPlugin[] = []
  const trustedRoots = resolveTrustedRoots(options.trustedRoots)
  for (const source of options.plugins) {
    if (!isSha256Digest(source.expectedDigest)) continue
    const parsed = parseAgentPluginSync(source, options, trustedRoots)
    if (!parsed.valid || parsed.trust !== 'trusted' || !parsed.digest) continue
    if (source.expectedDigest.toLowerCase() !== parsed.digest) continue
    loaded.push(new LoadedAgentPluginImpl(parsed, source, options.supportedTransports ?? ['stdio', 'streamable-http'], options.validationMode ?? 'strict', options.maxPackageBytes ?? 100 * 1024 * 1024))
  }
  return loaded
}

function parseAgentPluginSync(
  source: AgentPluginSource,
  options: InspectAgentPluginOptions,
  trustedRoots: readonly string[] = []
): ParsedAgentPlugin {
  const diagnostics: AgentPluginDiagnostic[] = []
  const requestedRoot = path.resolve(source.root)
  const maxFileBytes = positiveInteger(options.maxFileBytes, 2 * 1024 * 1024)
  const root = resolvePluginRoot(requestedRoot, diagnostics)
  if (!root) return parsedPlugin(requestedRoot, false, undefined, source.trust ?? 'untrusted', undefined, [], [], diagnostics)

  const trust: AgentPluginTrust = source.trust === 'trusted' || trustedRoots.some((trustedRoot) => isPathContained(trustedRoot, root)) ? 'trusted' : 'untrusted'

  const manifestPath = resolveRegularFile(root, 'plugin.json', diagnostics, undefined)
  if (!manifestPath) {
    diagnostics.push(diag('error', 'manifest_missing', 'Plugin root must contain a regular plugin.json manifest.'))
    return parsedPlugin(root, false, undefined, trust, undefined, [], [], diagnostics)
  }

  const manifestValue = readJson(manifestPath, maxFileBytes, diagnostics, root, 'manifest')
  const manifest = manifestValue === undefined ? undefined : parseManifest(manifestValue, diagnostics, root)
  if (!manifest) return parsedPlugin(root, false, undefined, trust, undefined, [], [], diagnostics)
  if (trust === 'untrusted') {
    diagnostics.push(diag('warn', 'untrusted', 'Plugin inventory is available for review, but bindings require explicit trust or a trusted root.', undefined, undefined, manifest.name))
  }

  const skills = discoverPluginSkills(root, maxFileBytes, diagnostics)
  const mcpServers = discoverMcpServers(root, maxFileBytes, diagnostics)
  const digest = digestPlugin(root, options.maxPackageBytes ?? 100 * 1024 * 1024, diagnostics)
  if (source.expectedDigest && digest && source.expectedDigest.toLowerCase() !== digest) {
    diagnostics.push(diag('error', 'digest_mismatch', 'Plugin package digest does not match the application-reviewed digest.', undefined, undefined, manifest.name))
  }
  return parsedPlugin(root, !!digest, manifest, trust, digest, skills, mcpServers, diagnostics)
}

function parsedPlugin(
  root: string,
  valid: boolean,
  manifest: AgentPluginManifest | undefined,
  trust: AgentPluginTrust,
  digest: string | undefined,
  skills: readonly ParsedAgentPluginSkill[],
  mcpServers: readonly AgentPluginMcpServer[],
  diagnostics: readonly AgentPluginDiagnostic[]
): ParsedAgentPlugin {
  return {
    root,
    valid,
    ...(manifest ? { manifest } : {}),
    trust,
    ...(digest ? { digest } : {}),
    skills,
    mcpServers,
    diagnostics
  }
}

function toInspection(plugin: ParsedAgentPlugin): AgentPluginInspection {
  const manifest = plugin.manifest
  const diagnostics = manifest
    ? plugin.diagnostics.map((diagnostic) => diagnostic.pluginName ? diagnostic : { ...diagnostic, pluginName: manifest.name })
    : plugin.diagnostics
  return {
    valid: plugin.valid,
    trust: plugin.trust,
    ...(manifest ? { manifest } : {}),
    ...(plugin.digest ? { digest: plugin.digest } : {}),
    skills: plugin.skills.map(({ name, description }) => ({ name, description })),
    mcpServers: plugin.mcpServers.map(({ name, type }) => ({ name, transport: type })),
    diagnostics
  }
}

class LoadedAgentPluginImpl implements LoadedAgentPlugin {
  public readonly inspection: AgentPluginInspection

  public constructor(
    private readonly plugin: ParsedAgentPlugin,
    private readonly source: AgentPluginSource,
    private readonly supportedTransports: readonly AgentPluginTransport[],
    private readonly validationMode: SkillValidationMode,
    private readonly maxStagedBytes: number
  ) {
    this.inspection = toInspection(plugin)
  }

  public bindings(options: {
    skills?: Readonly<Record<string, string>>
    tools?: Readonly<Record<string, AgentPluginToolBinding>>
  }): AgentPluginBindings {
    const skillBindings = bindSkills(this.plugin, options.skills, this.validationMode)
    const toolBindings = bindTools(this.plugin, this.source, options.tools, this.supportedTransports, this.maxStagedBytes)
    return {
      skills: skillBindings.skills,
      tools: toolBindings.tools,
      diagnostics: [...skillBindings.diagnostics, ...toolBindings.diagnostics],
      provenance: [...skillBindings.provenance, ...toolBindings.provenance]
    }
  }
}

function bindSkills(
  plugin: ParsedAgentPlugin,
  bindings: Readonly<Record<string, string>> | undefined,
  validationMode: SkillValidationMode
): { skills: SkillsConfig; diagnostics: AgentPluginDiagnostic[]; provenance: AgentPluginProvenance[] } {
  const skills: SkillsConfig = {}
  const diagnostics: AgentPluginDiagnostic[] = []
  const provenance: AgentPluginProvenance[] = []
  const byName = new Map(plugin.skills.map((skill) => [skill.name, skill]))
  for (const [alias, sourceName] of Object.entries(bindings ?? {})) {
    const skill = byName.get(sourceName)
    if (!skill) {
      diagnostics.push(diag('error', 'skill_invalid', `Selected plugin skill "${sourceName}" does not exist.`, undefined, 'skills', sourceName))
      continue
    }
    if (!skillNamePattern.test(alias)) {
      diagnostics.push(diag('error', 'skill_invalid', `Harness skill id "${alias}" must use the core harness skill-id format.`, undefined, 'skills', sourceName))
      continue
    }
    if (skills[alias]) {
      diagnostics.push(diag('error', 'skill_duplicate', `More than one plugin skill was projected to the harness skill id "${alias}".`, undefined, 'skills', sourceName))
      continue
    }
    skills[alias] = {
      directory: skill.directory,
      validationMode,
      trust: 'trusted',
      source: `agent_plugin:${plugin.manifest?.name ?? 'unknown'}`
    }
    if (plugin.manifest && plugin.digest) {
      provenance.push({
        pluginName: plugin.manifest.name,
        ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
        digest: plugin.digest,
        component: 'skill',
        componentName: skill.name
      })
    }
  }
  return { skills, diagnostics, provenance }
}

function bindTools(
  plugin: ParsedAgentPlugin,
  source: AgentPluginSource,
  bindings: Readonly<Record<string, AgentPluginToolBinding>> | undefined,
  supportedTransports: readonly AgentPluginTransport[],
  maxStagedBytes: number
): { tools: ToolsConfig; diagnostics: AgentPluginDiagnostic[]; provenance: AgentPluginProvenance[] } {
  const tools: ToolsConfig = {}
  const diagnostics: AgentPluginDiagnostic[] = []
  const provenance: AgentPluginProvenance[] = []
  const byName = new Map(plugin.mcpServers.map((server) => [server.name, server]))
  for (const [alias, binding] of Object.entries(bindings ?? {})) {
    const server = byName.get(binding.server)
    if (!server) {
      diagnostics.push(diag('error', 'server_invalid', `Selected MCP server "${binding.server}" does not exist.`, undefined, 'mcp', binding.server))
      continue
    }
    if (!/^[a-z][a-z0-9_]*$/.test(alias) || alias.length > 64) {
      diagnostics.push(diag('error', 'server_invalid', `Harness tool id "${alias}" must use the core harness tool-id format.`, undefined, 'mcp', binding.server))
      continue
    }
    if (!binding.tool || !binding.description) {
      diagnostics.push(diag('error', 'server_invalid', 'A selected MCP tool requires non-empty tool and description fields.', undefined, 'mcp', binding.server))
      continue
    }
    if (!supportedTransports.includes(server.type)) {
      diagnostics.push(diag('warn', 'transport_unsupported', `MCP transport "${server.type}" is disabled for this plugin load.`, undefined, 'mcp', server.name))
      continue
    }
    let launchSource = source
    if (server.type === 'stdio') {
      if (!source.dataDirectory) {
        diagnostics.push(diag('error', 'server_invalid', 'Trusted stdio plugins require an existing caller-owned dataDirectory for staged persistent data.', undefined, 'mcp', server.name))
        continue
      }
      try {
        launchSource = { ...source, dataDirectory: resolveDataDirectoryOutsidePluginRoot(source.dataDirectory, plugin.root) }
      } catch {
        diagnostics.push(diag('error', 'server_invalid', 'The caller-owned stdio plugin dataDirectory must be an existing directory outside the plugin root.', undefined, 'mcp', server.name))
        continue
      }
    }
    if (tools[alias]) {
      diagnostics.push(diag('error', 'server_invalid', `More than one selected MCP tool uses the harness tool id "${alias}".`, undefined, 'mcp', server.name))
      continue
    }
    tools[alias] = toHarnessMcpTool(plugin, launchSource, server, binding, maxStagedBytes)
    if (plugin.manifest && plugin.digest) {
      provenance.push({
        pluginName: plugin.manifest.name,
        ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
        digest: plugin.digest,
        component: 'mcp',
        componentName: server.name,
        transport: server.type
      })
    }
  }
  return { tools, diagnostics, provenance }
}

function toHarnessMcpTool(
  plugin: ParsedAgentPlugin,
  source: AgentPluginSource,
  server: AgentPluginMcpServer,
  binding: AgentPluginToolBinding,
  maxStagedBytes: number
): McpStdioToolDefinition | McpHttpToolDefinition {
  const provenance = plugin.manifest && plugin.digest
    ? {
        name: plugin.manifest.name,
        ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
        digest: plugin.digest,
        component: 'mcp' as const
      }
    : undefined
  if (server.type === 'stdio') {
    return {
      kind: 'mcp_stdio',
      description: binding.description,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: { ...server.env } } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      prepareLaunch: createPluginLaunchPreparer(plugin, source, server, maxStagedBytes),
      ...(provenance ? { provenance } : {}),
      tool: binding.tool
    }
  }
  return {
    kind: 'mcp_http',
    description: binding.description,
    url: server.url,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
    ...(provenance ? { provenance } : {}),
    tool: binding.tool
  }
}

const DATA_STAGING_MARKER = '.purista-agent-plugin-data'
const dataDirectoryLocks = new Map<string, Promise<void>>()

function createPluginLaunchPreparer(
  plugin: ParsedAgentPlugin,
  source: AgentPluginSource,
  server: AgentPluginStdioMcpServer,
  maxStagedBytes: number
): NonNullable<McpStdioToolDefinition['prepareLaunch']> {
  const digest = plugin.digest
  const dataDirectory = source.dataDirectory
  if (!digest || !dataDirectory) {
    throw new AgentPluginLoadError('A trusted plugin digest and caller-owned dataDirectory are required for stdio staging.')
  }
  const sandboxPluginRoot = `/plugins/${digest}/root`
  const sandboxDataRoot = `/plugins/${digest}/data`
  return async ({ sandbox, signal }) => {
    signal?.throwIfAborted()
    const freshDigest = digestPlugin(plugin.root, maxStagedBytes, [])
    if (freshDigest !== digest) {
      throw new AgentPluginLoadError('The trusted plugin changed after review and before staging.')
    }
    const dataRoot = resolveDataDirectoryOutsidePluginRoot(dataDirectory, plugin.root)
    const releaseDataLock = await acquireDataDirectoryLock(dataRoot)
    try {
      signal?.throwIfAborted()
      const packageFiles = collectNormalFiles(plugin.root, maxStagedBytes)
      const dataFiles = collectNormalFiles(dataRoot, maxStagedBytes)
      await sandbox.mount(packageFiles, sandboxPluginRoot)
      await sandbox.mount(dataFiles, sandboxDataRoot)
      // `mount` does not create a directory for an empty map. The marker is
      // excluded from synchronization and gives stdio cwd a durable directory.
      await sandbox.mount(new Map([[DATA_STAGING_MARKER, '']]), sandboxDataRoot)
      signal?.throwIfAborted()

      const command = server.command.startsWith('./')
        ? `${sandboxPluginRoot}/${server.command.slice(2)}`
        : server.command
      const args = server.args?.map((value) => expandPluginPlaceholders(value, sandboxPluginRoot, sandboxDataRoot))
      const cwd = server.cwd
        ? expandPluginPlaceholders(server.cwd, sandboxPluginRoot, sandboxDataRoot)
        : sandboxPluginRoot
      const env = {
        ...Object.fromEntries(Object.entries(server.env ?? {}).map(([name, value]) => [name, expandPluginPlaceholders(value, sandboxPluginRoot, sandboxDataRoot)])),
        PLUGIN_ROOT: sandboxPluginRoot,
        PLUGIN_DATA: sandboxDataRoot
      }
      let cleanupPromise: Promise<void> | undefined
      return {
        command,
        ...(args ? { args } : {}),
        cwd,
        env,
        cleanup: () => {
          cleanupPromise ??= syncSandboxData(sandbox, sandboxDataRoot, dataRoot, maxStagedBytes)
            .finally(releaseDataLock)
          return cleanupPromise
        }
      }
    } catch (error) {
      releaseDataLock()
      throw error
    }
  }
}

function expandPluginPlaceholders(value: string, pluginRoot: string, pluginData: string): string {
  return value.replaceAll('${PLUGIN_ROOT}', pluginRoot).replaceAll('${PLUGIN_DATA}', pluginData)
}

function resolveDataDirectoryOutsidePluginRoot(directory: string, pluginRoot: string): string {
  const requested = path.resolve(directory)
  try {
    const resolved = fs.realpathSync.native(requested)
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory')
    if (pathsOverlap(pluginRoot, resolved)) throw new Error('overlaps plugin root')
    return resolved
  } catch (error) {
    throw new AgentPluginLoadError('The caller-owned plugin dataDirectory must be an existing directory outside the plugin root.', { cause: error })
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left)
}

async function acquireDataDirectoryLock(dataRoot: string): Promise<() => void> {
  const previous = dataDirectoryLocks.get(dataRoot) ?? Promise.resolve()
  let resolveCurrent: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve
  })
  dataDirectoryLocks.set(dataRoot, current)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    resolveCurrent?.()
    if (dataDirectoryLocks.get(dataRoot) === current) dataDirectoryLocks.delete(dataRoot)
  }
}

function collectNormalFiles(root: string, maxBytes: number): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  const walk = (directory: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      throw new AgentPluginLoadError('A trusted plugin staging directory could not be read.', { cause: error })
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(candidate)
      } catch (error) {
        throw new AgentPluginLoadError('A trusted plugin staging entry could not be read.', { cause: error })
      }
      if (stat.isDirectory()) {
        walk(candidate)
        continue
      }
      if (!stat.isFile()) continue
      const relative = path.relative(root, candidate)
      let resolved: string
      try {
        resolved = fs.realpathSync.native(candidate)
      } catch (error) {
        throw new AgentPluginLoadError('A trusted plugin staging entry could not be resolved.', { cause: error })
      }
      if (!isPathContained(root, resolved) || relative === '') {
        throw new AgentPluginLoadError('A trusted plugin staging entry escapes its approved root.')
      }
      let data: Buffer
      try {
        data = fs.readFileSync(candidate)
      } catch (error) {
        throw new AgentPluginLoadError('A trusted plugin staging file could not be read.', { cause: error })
      }
      totalBytes += data.byteLength
      if (totalBytes > positiveInteger(maxBytes, 100 * 1024 * 1024)) {
        throw new AgentPluginLoadError('The trusted plugin staging directory exceeds its byte limit.')
      }
      files.set(relative.split(path.sep).join('/'), data)
    }
  }
  walk(root)
  return files
}

async function syncSandboxData(
  sandbox: { list(path: string, opts?: { recursive?: boolean }): Promise<readonly { path: string; kind: string }[]>; read(path: string): Promise<Uint8Array> },
  sandboxDataRoot: string,
  hostDataRoot: string,
  maxBytes: number
): Promise<void> {
  let totalBytes = 0
  const entries = await sandbox.list(sandboxDataRoot, { recursive: true })
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const relative = path.posix.relative(sandboxDataRoot, entry.path)
    if (!relative || relative === DATA_STAGING_MARKER || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      if (relative === DATA_STAGING_MARKER) continue
      throw new AgentPluginLoadError('Sandbox plugin data contains an invalid path.')
    }
    const target = path.resolve(hostDataRoot, ...relative.split('/'))
    if (!isPathContained(hostDataRoot, target)) throw new AgentPluginLoadError('Sandbox plugin data escapes the caller-owned dataDirectory.')
    const data = await sandbox.read(entry.path)
    totalBytes += data.byteLength
    if (totalBytes > positiveInteger(maxBytes, 100 * 1024 * 1024)) {
      throw new AgentPluginLoadError('Sandbox plugin data exceeds its byte limit.')
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
}

function isSha256Digest(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value)
}

function resolveTrustedRoots(roots: readonly string[] | undefined): readonly string[] {
  const resolved: string[] = []
  for (const root of roots ?? []) {
    try {
      if (fs.statSync(root).isDirectory()) resolved.push(fs.realpathSync.native(root))
    } catch {
      // A missing trusted root grants no trust. It is never an implicit fallback.
    }
  }
  return resolved
}

function digestPlugin(root: string, maxBytes: number, diagnostics: AgentPluginDiagnostic[]): string | undefined {
  const hasher = crypto.createHash('sha256')
  let totalBytes = 0
  const files: Array<{ relative: string; absolute: string }> = []
  const visitedDirectories = new Set<string>()
  const walk = (directory: string): boolean => {
    if (visitedDirectories.has(directory)) return true
    visitedDirectories.add(directory)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      diagnostics.push(diag('error', 'component_invalid', 'Plugin package could not be read while calculating its review digest.'))
      return false
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(candidate)
      } catch {
        diagnostics.push(diag('error', 'component_invalid', 'Plugin package entry could not be read while calculating its review digest.'))
        return false
      }
      let real: string
      try {
        real = fs.realpathSync.native(candidate)
      } catch {
        diagnostics.push(diag('error', 'component_invalid', 'Plugin package entry could not be resolved while calculating its review digest.'))
        return false
      }
      if (!isPathContained(root, real)) {
        diagnostics.push(diag('error', 'path_escape', 'Plugin package entry resolves outside the plugin root.'))
        // Discovery already applies the narrower component failure boundary.
        // Do not read or hash an escaping entry, and do not let an unselected
        // symlink suppress a valid sibling component.
        continue
      }
      if (stat.isDirectory()) {
        if (!walk(real)) return false
      } else if (stat.isFile()) {
        files.push({ relative: path.relative(root, candidate).split(path.sep).join('/'), absolute: real })
      }
    }
    return true
  }
  if (!walk(root)) return undefined
  files.sort((left, right) => left.relative.localeCompare(right.relative))
  for (const file of files) {
    let data: Buffer
    try {
      data = fs.readFileSync(file.absolute)
    } catch {
      diagnostics.push(diag('error', 'component_invalid', 'Plugin package file could not be read while calculating its review digest.'))
      return undefined
    }
    totalBytes += data.byteLength
    if (totalBytes > positiveInteger(maxBytes, 100 * 1024 * 1024)) {
      diagnostics.push(diag('error', 'component_invalid', 'Plugin package exceeds the configured digest byte limit.'))
      return undefined
    }
    hasher.update(file.relative, 'utf8')
    hasher.update('\0', 'utf8')
    hasher.update(data)
    hasher.update('\0', 'utf8')
  }
  return hasher.digest('hex')
}

function diag(
  level: AgentPluginDiagnostic['level'],
  code: AgentPluginDiagnostic['code'],
  message: string,
  _pluginRoot?: string,
  component?: AgentPluginDiagnostic['component'],
  item?: string,
  _diagnosticPath?: string
): AgentPluginDiagnostic {
  return {
    level,
    code,
    message,
    ...(component ? { component } : {}),
    ...(item ? { item } : {})
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function resolvePluginRoot(requestedRoot: string, diagnostics: AgentPluginDiagnostic[]): string | undefined {
  try {
    if (!fs.statSync(requestedRoot).isDirectory()) {
      diagnostics.push(diag('error', 'plugin_root_invalid', 'Plugin root must resolve to a directory.', undefined, undefined, undefined, requestedRoot))
      return undefined
    }
    return fs.realpathSync.native(requestedRoot)
  } catch {
    diagnostics.push(diag('error', 'plugin_root_invalid', 'Plugin root is missing or cannot be read.', undefined, undefined, undefined, requestedRoot))
    return undefined
  }
}

function resolveRegularFile(
  root: string,
  relativePath: string,
  diagnostics: AgentPluginDiagnostic[],
  component: AgentPluginDiagnostic['component'] | undefined,
  item?: string
): string | undefined {
  const candidate = path.join(root, relativePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate)
  } catch {
    return undefined
  }
  if (!stat.isFile()) {
    diagnostics.push(diag('error', 'component_invalid', `Expected ${relativePath} to resolve to a regular file.`, root, component, item, candidate))
    return undefined
  }
  try {
    const real = fs.realpathSync.native(candidate)
    if (!isPathContained(root, real)) {
      diagnostics.push(diag('error', 'path_escape', `${relativePath} resolves outside the plugin root.`, root, component, item, candidate))
      return undefined
    }
    return real
  } catch {
    diagnostics.push(diag('error', 'component_invalid', `Could not resolve ${relativePath}.`, root, component, item, candidate))
    return undefined
  }
}

function resolveDirectory(
  root: string,
  relativePath: string,
  diagnostics: AgentPluginDiagnostic[],
  component: AgentPluginDiagnostic['component'],
  item?: string
): string | undefined {
  const candidate = path.join(root, relativePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate)
  } catch {
    return undefined
  }
  if (!stat.isDirectory()) {
    diagnostics.push(diag('error', 'component_invalid', `Expected ${relativePath} to resolve to a directory.`, root, component, item, candidate))
    return undefined
  }
  try {
    const real = fs.realpathSync.native(candidate)
    if (!isPathContained(root, real)) {
      diagnostics.push(diag('error', 'path_escape', `${relativePath} resolves outside the plugin root.`, root, component, item, candidate))
      return undefined
    }
    return real
  } catch {
    diagnostics.push(diag('error', 'component_invalid', `Could not resolve ${relativePath}.`, root, component, item, candidate))
    return undefined
  }
}

function readJson(
  filePath: string,
  maxFileBytes: number,
  diagnostics: AgentPluginDiagnostic[],
  root: string,
  kind: 'manifest' | 'mcp'
): unknown | undefined {
  const code = kind === 'manifest' ? 'manifest_invalid' : 'mcp_config_invalid'
  try {
    if (fs.statSync(filePath).size > maxFileBytes) {
      diagnostics.push(diag('error', code, `${kind === 'manifest' ? 'plugin.json' : 'mcp.json'} exceeds the configured file-size limit.`, root, kind === 'mcp' ? 'mcp' : undefined, undefined, filePath))
      return undefined
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  } catch {
    diagnostics.push(diag('error', code, `${kind === 'manifest' ? 'plugin.json' : 'mcp.json'} must contain valid JSON.`, root, kind === 'mcp' ? 'mcp' : undefined, undefined, filePath))
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseManifest(value: unknown, diagnostics: AgentPluginDiagnostic[], root: string): AgentPluginManifest | undefined {
  const data = asRecord(value)
  if (!data) {
    diagnostics.push(diag('error', 'manifest_invalid', 'plugin.json must contain a top-level object.', root))
    return undefined
  }

  const known = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
  for (const key of Object.keys(data)) {
    if (!known.has(key)) diagnostics.push(diag('warn', 'manifest_unknown_field', `Ignoring unknown plugin.json field "${key}".`, root, undefined, key))
  }
  if (data['$schema'] !== AGENT_PLUGIN_MANIFEST_SCHEMA) {
    diagnostics.push(diag('error', 'schema_unsupported', `plugin.json $schema must equal "${AGENT_PLUGIN_MANIFEST_SCHEMA}".`, root))
    return undefined
  }
  const name = stringField(data, 'name')
  if (!name || !pluginNamePattern.test(name)) {
    diagnostics.push(diag('error', 'manifest_invalid', 'plugin.json name must be 1-64 lowercase letters, numbers, hyphens, or periods with no repeated hyphens or periods.', root))
    return undefined
  }

  const metadata = ['version', 'description', 'homepage', 'repository', 'license'] as const
  for (const key of metadata) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      diagnostics.push(diag('error', 'manifest_invalid', `plugin.json ${key} must be a string when present.`, root))
      return undefined
    }
  }
  const author = parseAuthor(data['author'])
  if (data['author'] !== undefined && !author) {
    diagnostics.push(diag('error', 'manifest_invalid', 'plugin.json author must be an object containing only optional name, email, and url strings.', root))
    return undefined
  }
  const keywords = parseStringArray(data['keywords'])
  if (data['keywords'] !== undefined && !keywords) {
    diagnostics.push(diag('error', 'manifest_invalid', 'plugin.json keywords must be an array of strings.', root))
    return undefined
  }

  let extensions: Record<string, unknown> | undefined
  if (data['extensions'] !== undefined) {
    extensions = asRecord(data['extensions'])
    if (!extensions) {
      diagnostics.push(diag('warn', 'manifest_extensions_ignored', 'Ignoring non-object plugin.json extensions.', root))
    }
  }
  return {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name,
    ...(typeof data['version'] === 'string' ? { version: data['version'] } : {}),
    ...(typeof data['description'] === 'string' ? { description: data['description'] } : {}),
    ...(author ? { author } : {}),
    ...(typeof data['homepage'] === 'string' ? { homepage: data['homepage'] } : {}),
    ...(typeof data['repository'] === 'string' ? { repository: data['repository'] } : {}),
    ...(typeof data['license'] === 'string' ? { license: data['license'] } : {}),
    ...(keywords ? { keywords } : {}),
    ...(extensions ? { extensions } : {})
  }
}

function parseAuthor(value: unknown): AgentPluginAuthor | undefined {
  const author = asRecord(value)
  if (!author) return undefined
  const known = new Set(['name', 'email', 'url'])
  if (Object.keys(author).some((key) => !known.has(key) || typeof author[key] !== 'string')) return undefined
  return {
    ...(typeof author['name'] === 'string' ? { name: author['name'] } : {}),
    ...(typeof author['email'] === 'string' ? { email: author['email'] } : {}),
    ...(typeof author['url'] === 'string' ? { url: author['url'] } : {})
  }
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function discoverPluginSkills(root: string, maxFileBytes: number, diagnostics: AgentPluginDiagnostic[]): ParsedAgentPluginSkill[] {
  const skillsRoot = resolveDirectory(root, 'skills', diagnostics, 'skills')
  if (!skillsRoot) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    diagnostics.push(diag('error', 'component_invalid', 'Could not read the skills directory.', root, 'skills', undefined, skillsRoot))
    return []
  }
  const skills: ParsedAgentPluginSkill[] = []
  const names = new Set<string>()
  for (const entry of entries) {
    const childPath = path.join(skillsRoot, entry.name)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const directory = resolveSkillDirectory(root, childPath, diagnostics, entry.name)
    if (!directory) continue
    const skillPath = resolveRegularFile(root, path.relative(root, path.join(directory, 'SKILL.md')), diagnostics, 'skills', entry.name)
    if (!skillPath) continue
    const parsed = parseSkill(skillPath, maxFileBytes, root, diagnostics, entry.name)
    if (!parsed) continue
    if (names.has(parsed.name)) {
      diagnostics.push(diag('error', 'skill_duplicate', `More than one plugin skill declares the name "${parsed.name}".`, root, 'skills', parsed.name, directory))
      continue
    }
    names.add(parsed.name)
    skills.push({ name: parsed.name, description: parsed.description, directory, skillPath })
  }
  return skills
}

function resolveSkillDirectory(
  root: string,
  candidate: string,
  diagnostics: AgentPluginDiagnostic[],
  item: string
): string | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate)
  } catch {
    return undefined
  }
  if (!stat.isDirectory()) return undefined
  try {
    const real = fs.realpathSync.native(candidate)
    if (!isPathContained(root, real)) {
      diagnostics.push(diag('error', 'path_escape', 'Skill directory resolves outside the plugin root.', root, 'skills', item, candidate))
      return undefined
    }
    return real
  } catch {
    diagnostics.push(diag('error', 'skill_invalid', 'Could not resolve skill directory.', root, 'skills', item, candidate))
    return undefined
  }
}

function parseSkill(
  skillPath: string,
  maxFileBytes: number,
  root: string,
  diagnostics: AgentPluginDiagnostic[],
  item: string
): { name: string; description: string } | undefined {
  let content: string
  try {
    if (fs.statSync(skillPath).size > maxFileBytes) {
      diagnostics.push(diag('error', 'skill_invalid', 'SKILL.md exceeds the configured file-size limit.', root, 'skills', item, skillPath))
      return undefined
    }
    content = fs.readFileSync(skillPath, 'utf8')
  } catch {
    diagnostics.push(diag('error', 'skill_invalid', 'Could not read SKILL.md.', root, 'skills', item, skillPath))
    return undefined
  }
  const frontmatter = extractFrontmatter(content)
  if (!frontmatter) {
    diagnostics.push(diag('error', 'skill_invalid', 'SKILL.md must start with terminated YAML frontmatter.', root, 'skills', item, skillPath))
    return undefined
  }
  const parsed = parseDocument(frontmatter, { strict: true })
  if (parsed.errors.length > 0) {
    diagnostics.push(diag('error', 'skill_invalid', 'SKILL.md contains invalid YAML frontmatter.', root, 'skills', item, skillPath))
    return undefined
  }
  const data = asRecord(parsed.toJSON())
  const name = data ? stringField(data, 'name') : undefined
  const description = data ? stringField(data, 'description') : undefined
  if (!name || !skillNamePattern.test(name) || !description || description.length > 1024) {
    diagnostics.push(diag('error', 'skill_invalid', 'SKILL.md requires a valid skill name and a description of at most 1024 characters.', root, 'skills', item, skillPath))
    return undefined
  }
  return { name, description }
}

function extractFrontmatter(content: string): string | undefined {
  const prefix = content.startsWith('---\n') ? 4 : content.startsWith('---\r\n') ? 5 : -1
  if (prefix < 0) return undefined
  const match = /\r?\n---(?:\r?\n|$)/.exec(content.slice(prefix))
  if (!match || match.index === undefined) return undefined
  return content.slice(prefix, prefix + match.index)
}

function discoverMcpServers(root: string, maxFileBytes: number, diagnostics: AgentPluginDiagnostic[]): AgentPluginMcpServer[] {
  const mcpPath = resolveRegularFile(root, 'mcp.json', diagnostics, 'mcp')
  if (!mcpPath) return []
  const value = readJson(mcpPath, maxFileBytes, diagnostics, root, 'mcp')
  const data = asRecord(value)
  if (!data) {
    if (value !== undefined) diagnostics.push(diag('error', 'mcp_config_invalid', 'mcp.json must contain a top-level object.', root, 'mcp', undefined, mcpPath))
    return []
  }
  const allowed = new Set(['$schema', 'mcpServers'])
  if (Object.keys(data).some((key) => !allowed.has(key)) || data['$schema'] !== AGENT_PLUGIN_MCP_SCHEMA) {
    diagnostics.push(diag('error', 'mcp_config_invalid', 'mcp.json must use the Agent Plugins v1 schema and contain no unknown top-level fields.', root, 'mcp', undefined, mcpPath))
    return []
  }
  const servers = asRecord(data['mcpServers'])
  if (!servers) {
    diagnostics.push(diag('error', 'mcp_config_invalid', 'mcp.json mcpServers must be an object.', root, 'mcp', undefined, mcpPath))
    return []
  }
  const result: AgentPluginMcpServer[] = []
  for (const [name, config] of Object.entries(servers)) {
    const server = parseMcpServer(name, config, root, diagnostics)
    if (server) result.push(server)
  }
  return result
}

function parseMcpServer(name: string, value: unknown, root: string, diagnostics: AgentPluginDiagnostic[]): AgentPluginMcpServer | undefined {
  const config = asRecord(value)
  if (!config || !name) {
    diagnostics.push(diag('error', 'server_invalid', 'Each MCP server must have a non-empty name and an object configuration.', root, 'mcp', name))
    return undefined
  }
  if (config['type'] === 'stdio') return parseStdioServer(name, config, root, diagnostics)
  if (config['type'] === 'streamable-http') return parseHttpServer(name, config, root, diagnostics)
  if (config['type'] === 'sse') {
    diagnostics.push(diag('warn', 'transport_unsupported', 'Legacy MCP HTTP+SSE is not supported by the current harness MCP transport.', root, 'mcp', name))
    return undefined
  }
  diagnostics.push(diag('error', 'server_invalid', 'MCP server type must be stdio or streamable-http.', root, 'mcp', name))
  return undefined
}

function parseStdioServer(name: string, config: Record<string, unknown>, root: string, diagnostics: AgentPluginDiagnostic[]): AgentPluginStdioMcpServer | undefined {
  const allowed = new Set(['type', 'command', 'args', 'env', 'cwd'])
  const command = stringField(config, 'command')
  const args = config['args'] === undefined ? undefined : parseStringArray(config['args'])
  const env = config['env'] === undefined ? undefined : parseStringRecord(config['env'])
  const cwd = config['cwd'] === undefined ? undefined : stringField(config, 'cwd')
  if (!command || /\s/.test(command) || Object.keys(config).some((key) => !allowed.has(key)) || (config['args'] !== undefined && !args) || (config['env'] !== undefined && !env) || hasReservedPluginEnvironmentName(env) || (config['cwd'] !== undefined && !cwd)) {
    diagnostics.push(diag('error', 'server_invalid', 'Invalid stdio MCP server configuration.', root, 'mcp', name))
    return undefined
  }
  if ((command.includes('/') || command.includes('\\')) && (!command.startsWith('./') || !isPluginRelativePathContained(root, command))) {
    diagnostics.push(diag('error', 'server_invalid', 'Plugin-relative stdio command escapes the plugin root.', root, 'mcp', name))
    return undefined
  }
  if (cwd && !isValidStdioCwd(root, cwd)) {
    diagnostics.push(diag('error', 'server_invalid', 'stdio cwd must be plugin-relative, ${PLUGIN_ROOT}-rooted, or ${PLUGIN_DATA}-rooted and remain contained.', root, 'mcp', name))
    return undefined
  }
  return {
    name,
    type: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {})
  }
}

function parseHttpServer(name: string, config: Record<string, unknown>, root: string, diagnostics: AgentPluginDiagnostic[]): AgentPluginHttpMcpServer | undefined {
  const allowed = new Set(['type', 'url', 'headers'])
  const type = config['type']
  const url = stringField(config, 'url')
  const headers = config['headers'] === undefined ? undefined : parseHeaders(config['headers'])
  if (type !== 'streamable-http' || !url || Object.keys(config).some((key) => !allowed.has(key)) || (config['headers'] !== undefined && !headers) || !isSecurePluginUrl(url)) {
    diagnostics.push(diag('error', 'server_invalid', 'Invalid HTTP MCP server configuration.', root, 'mcp', name))
    return undefined
  }
  return { name, type, url, ...(headers ? { headers } : {}) }
}

function parseStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  const record = asRecord(value)
  if (!record || Object.values(record).some((entry) => typeof entry !== 'string')) return undefined
  return record as Record<string, string>
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  const headers = parseStringRecord(value)
  if (!headers) return undefined
  const names = new Set<string>()
  for (const [name, headerValue] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (
      !headerNamePattern.test(name) ||
      /[\0\r\n]/.test(headerValue) ||
      names.has(normalized) ||
      prohibitedPluginHeaders.has(normalized) ||
      normalized.startsWith('mcp-')
    ) return undefined
    names.add(normalized)
  }
  return headers
}

function hasReservedPluginEnvironmentName(env: Readonly<Record<string, string>> | undefined): boolean {
  if (!env) return false
  const normalize = process.platform === 'win32' ? (name: string) => name.toUpperCase() : (name: string) => name
  return Object.keys(env).some((name) => {
    const normalized = normalize(name)
    return normalized === 'PLUGIN_ROOT' || normalized === 'PLUGIN_DATA'
  })
}

function isPluginRelativePathContained(root: string, configuredPath: string): boolean {
  if (!configuredPath.startsWith('./')) return false
  const candidate = path.resolve(root, configuredPath)
  if (!isPathContained(root, candidate)) return false
  try {
    return isPathContained(root, fs.realpathSync.native(candidate))
  } catch {
    // The runtime must repeat containment before executing a path that was not
    // present at inspection time. This data-only package never executes it.
    return true
  }
}

function isValidStdioCwd(root: string, cwd: string): boolean {
  if (cwd.startsWith('./')) return isPluginRelativePathContained(root, cwd)
  if (cwd === '${PLUGIN_ROOT}') return true
  if (cwd.startsWith('${PLUGIN_ROOT}/')) return isPluginRelativePathContained(root, `./${cwd.slice('${PLUGIN_ROOT}/'.length)}`)
  return cwd === '${PLUGIN_DATA}' || cwd.startsWith('${PLUGIN_DATA}/')
}

function isSecurePluginUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) return false
  if (url.protocol === 'https:') return true
  return isLoopbackHost(url.hostname)
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host === '::1') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255)
}
