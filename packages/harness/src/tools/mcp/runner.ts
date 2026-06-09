import {
  McpProtocolError,
  OperationCancelledError,
  OperationTimeoutError,
  ToolError,
  ToolNotFoundError,
  ValidationError
} from '../../errors/index.js'
import type { McpHttpToolDefinition, McpStdioToolDefinition, ToolDefinition, ToolsConfig } from '../../harness/defineHarness.js'
import type { JsonValue } from '../../models/json.js'
import type { ModelToolSpec } from '../../ports/model-provider.js'
import type { SandboxSession } from '../../sandbox/index.js'
import { assertMcpJsonSchema, validateMcpJsonSchema, type McpSchemaWarning } from './schema.js'

export type McpToolKind = 'mcp_stdio' | 'mcp_http'
export type McpTransport = 'stdio' | 'http'

export interface ResolvedMcpTool {
  localToolId: string
  kind: McpToolKind
  description: string
  upstreamToolName: string
  timeoutMs: number
  serverKey: string
  inputAdapter?: (input: unknown) => unknown
  outputAdapter?: (output: unknown) => unknown
}

export interface ResolvedMcpStdioTool extends ResolvedMcpTool {
  kind: 'mcp_stdio'
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  install?: McpStdioToolDefinition['install']
  sandbox: SandboxSession
}

export interface ResolvedMcpHttpTool extends ResolvedMcpTool {
  kind: 'mcp_http'
  url: string
  auth?: McpHttpToolDefinition['auth']
  headers?: Record<string, string>
}

export type ResolvedMcpToolConfig = ResolvedMcpStdioTool | ResolvedMcpHttpTool

export interface McpDiscoveredTool {
  name: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
}

export interface McpTransportRunner {
  listTools(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpDiscoveredTool[]>
  callTool(name: string, input: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>
  close(): Promise<void>
}

export interface McpRunnerRegistry {
  getRunner(config: ResolvedMcpToolConfig): McpTransportRunner
  close(): Promise<void>
}

export interface McpFacadeContext {
  signal?: AbortSignal
  toolTimeoutMs?: number
  sandbox?: SandboxSession
  sandboxKey?: string
  registry?: McpRunnerRegistry
  warn?: (warning: McpSchemaWarning) => void
}

const discoveredCache = new WeakMap<McpTransportRunner, Promise<McpDiscoveredTool[]>>()

export async function getMcpToolSpecs(tools: ToolsConfig, allowlist: Iterable<string>, ctx: McpFacadeContext = {}): Promise<ModelToolSpec[]> {
  const allowed = new Set(allowlist)
  const registry = ctx.registry ?? createMcpRunnerRegistry()
  const specs = await Promise.all(Object.entries(tools).map(async ([toolId, tool]) => {
    if (!allowed.has(toolId) || !isMcpToolDefinition(tool)) return undefined
    const config = resolveMcpTool(toolId, tool, ctx)
    return getResolvedModelToolSpec(config, registry.getRunner(config), ctx.signal, ctx.warn)
  }))
  return specs.filter((spec): spec is ModelToolSpec => spec !== undefined)
}

export async function invokeMcpTool(toolId: string, tool: ToolDefinition, input: unknown, ctx: McpFacadeContext): Promise<JsonValue>
export async function invokeMcpTool(config: ResolvedMcpToolConfig, runner: McpTransportRunner, input: unknown, signal?: AbortSignal): Promise<JsonValue>
export async function invokeMcpTool(
  first: string | ResolvedMcpToolConfig,
  second: ToolDefinition | McpTransportRunner,
  input: unknown,
  fourth?: McpFacadeContext | AbortSignal
): Promise<JsonValue> {
  if (typeof first === 'string') {
    if (!isMcpToolDefinition(second)) throw new ToolNotFoundError('Tool is not an MCP tool.', { tool_id: first, where: 'registry' })
    const ctx = isAbortSignal(fourth) ? { signal: fourth } : fourth ?? {}
    const registry = ctx.registry ?? createMcpRunnerRegistry()
    const config = resolveMcpTool(first, second, ctx)
    return invokeResolvedMcpTool(config, registry.getRunner(config), input, ctx.signal, ctx.warn)
  }
  return invokeResolvedMcpTool(first, second as McpTransportRunner, input, isAbortSignal(fourth) ? fourth : fourth?.signal, isAbortSignal(fourth) ? undefined : fourth?.warn)
}

export async function getModelToolSpec(config: ResolvedMcpToolConfig, runner: McpTransportRunner, signal?: AbortSignal): Promise<ModelToolSpec> {
  return getResolvedModelToolSpec(config, runner, signal)
}

export function createMcpRunnerRegistry(): McpRunnerRegistry {
  const runners = new Map<string, McpTransportRunner>()
  return {
    getRunner(config) {
      const existing = runners.get(config.localToolId)
      if (existing) return existing
      const runner = config.kind === 'mcp_stdio'
        ? createDynamicStdioRunner(config)
        : createDynamicHttpRunner(config)
      runners.set(config.localToolId, runner)
      return runner
    },
    async close() {
      await Promise.all([...runners.values()].map((runner) => runner.close()))
      runners.clear()
    }
  }
}

export function normalizeMcpOutput(result: unknown): JsonValue {
  if (isRecord(result) && isJsonValue(result.structuredContent)) return result.structuredContent
  if (!isRecord(result) || !Array.isArray(result.content)) return isJsonValue(result) ? result : null

  const normalized = result.content.map(normalizeContentBlock)
  if (normalized.length === 0) return null
  if (normalized.every((item) => typeof item === 'string')) return normalized.join('\n')
  if (normalized.length === 1) return normalized[0] ?? null
  return { content: normalized.filter(isJsonValue) }
}

export function toMcpTransport(kind: McpToolKind): McpTransport {
  return kind === 'mcp_stdio' ? 'stdio' : 'http'
}

async function getResolvedModelToolSpec(config: ResolvedMcpToolConfig, runner: McpTransportRunner, signal?: AbortSignal, warn?: (warning: McpSchemaWarning) => void): Promise<ModelToolSpec> {
  const tool = await discoverConfiguredTool(config, runner, signal, warn)
  const description = tool.description ? `${config.description}\n\n${tool.description}` : config.description
  return { name: config.localToolId, description, parameters: tool.inputSchema as JsonValue }
}

async function invokeResolvedMcpTool(config: ResolvedMcpToolConfig, runner: McpTransportRunner, input: unknown, signal?: AbortSignal, warn?: (warning: McpSchemaWarning) => void): Promise<JsonValue> {
  const tool = await discoverConfiguredTool(config, runner, signal, warn)
  const adaptedInput = config.inputAdapter ? config.inputAdapter(input) : input
  const validatedInput = validateMcpJsonSchema({ toolId: config.localToolId, where: 'mcp_input', schema: tool.inputSchema, value: adaptedInput, ...(warn ? { warn } : {}) })
  const result = await runner.callTool(config.upstreamToolName, validatedInput, { ...(signal ? { signal } : {}), timeoutMs: config.timeoutMs })
  if (isRecord(result) && result.isError === true) {
    throw new ToolError('MCP tool returned an error.', { tool_id: config.localToolId, tool_kind: config.kind })
  }
  const normalized = normalizeMcpOutput(result)
  const validatedOutput = tool.outputSchema
    ? validateMcpJsonSchema({ toolId: config.localToolId, where: 'mcp_output', schema: tool.outputSchema, value: normalized, ...(warn ? { warn } : {}) })
    : normalized
  const adaptedOutput = config.outputAdapter ? config.outputAdapter(validatedOutput) : validatedOutput
  if (!isJsonValue(adaptedOutput)) {
    throw new ValidationError('MCP output adapter returned a non-JSON value.', { where: 'mcp_output', issues: [{ path: '', message: 'Value must be JSON serializable.' }] })
  }
  return adaptedOutput
}

async function discoverConfiguredTool(config: ResolvedMcpToolConfig, runner: McpTransportRunner, signal?: AbortSignal, warn?: (warning: McpSchemaWarning) => void): Promise<McpDiscoveredTool> {
  let promise = discoveredCache.get(runner)
  if (!promise) {
    promise = runner.listTools({ ...(signal ? { signal } : {}), timeoutMs: config.timeoutMs })
    void promise.catch(() => {
      if (discoveredCache.get(runner) === promise) discoveredCache.delete(runner)
    })
    discoveredCache.set(runner, promise)
  }
  const tools = await promise
  const tool = tools.find((candidate) => candidate.name === config.upstreamToolName)
  if (!tool) throw new ToolNotFoundError('MCP upstream tool was not found.', { tool_id: config.localToolId, where: 'registry' })
  try {
    assertMcpJsonSchema(config.localToolId, tool.inputSchema, 'mcp_input', warn)
    if (tool.outputSchema !== undefined) assertMcpJsonSchema(config.localToolId, tool.outputSchema, 'mcp_output', warn)
  } catch (error) {
    if (error instanceof ValidationError) throw new McpProtocolError('MCP tool schema is malformed.', { tool_id: config.localToolId, transport: toMcpTransport(config.kind), phase: 'list' }, error)
    throw error
  }
  return tool
}

function resolveMcpTool(toolId: string, tool: McpStdioToolDefinition | McpHttpToolDefinition, ctx: McpFacadeContext): ResolvedMcpToolConfig {
  const base = {
    localToolId: toolId,
    description: tool.description,
    upstreamToolName: tool.tool,
    timeoutMs: ctx.toolTimeoutMs ?? 120_000,
    serverKey: toolId,
    ...(tool.inputAdapter ? { inputAdapter: tool.inputAdapter } : {}),
    ...(tool.outputAdapter ? { outputAdapter: tool.outputAdapter } : {})
  }
  if (tool.kind === 'mcp_stdio') {
    if (!ctx.sandbox) throw new ToolNotFoundError('MCP stdio tool requires a sandbox session.', { tool_id: toolId, where: 'registry' })
    return {
      ...base,
      kind: 'mcp_stdio',
      serverKey: `${toolId}:${ctx.sandboxKey ?? 'sandbox'}`,
      command: tool.command,
      ...(tool.args ? { args: tool.args } : {}),
      ...(tool.env ? { env: tool.env } : {}),
      ...(tool.install ? { install: tool.install } : {}),
      sandbox: ctx.sandbox
    }
  }
  return {
    ...base,
    kind: 'mcp_http',
    url: tool.url,
    ...(tool.auth ? { auth: tool.auth } : {}),
    ...(tool.headers ? { headers: tool.headers } : {})
  }
}

export function isMcpToolDefinition(tool: ToolDefinition | McpTransportRunner): tool is McpStdioToolDefinition | McpHttpToolDefinition {
  return isRecord(tool) && (tool.kind === 'mcp_stdio' || tool.kind === 'mcp_http')
}

function createDynamicStdioRunner(config: ResolvedMcpStdioTool): McpTransportRunner {
  let runnerPromise: Promise<McpTransportRunner> | undefined
  return dynamicRunner(() => {
    runnerPromise ??= import('./stdio.js').then((module) => module.createStdioMcpTransportRunner(config))
    return runnerPromise
  })
}

function createDynamicHttpRunner(config: ResolvedMcpHttpTool): McpTransportRunner {
  let runnerPromise: Promise<McpTransportRunner> | undefined
  return dynamicRunner(() => {
    runnerPromise ??= import('./http.js').then((module) => module.createHttpMcpTransportRunner(config))
    return runnerPromise
  })
}

function dynamicRunner(load: () => Promise<McpTransportRunner>): McpTransportRunner {
  return {
    async listTools(options) { return (await load()).listTools(options) },
    async callTool(name, input, options) { return (await load()).callTool(name, input, options) },
    async close() { await (await load()).close() }
  }
}

function normalizeContentBlock(block: unknown): JsonValue {
  if (!isRecord(block)) return null
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if ((block.type === 'image' || block.type === 'audio') && typeof block.mimeType === 'string') {
    return { contentType: block.mimeType, ...(typeof block.data === 'string' ? { data: block.data } : {}) }
  }
  if (block.type === 'resource' && isRecord(block.resource)) {
    const resource = block.resource
    return {
      ...(typeof resource.mimeType === 'string' ? { contentType: resource.mimeType } : {}),
      ...(typeof resource.uri === 'string' ? { uri: resource.uri } : {}),
      ...(typeof resource.text === 'string' ? { data: resource.text } : {}),
      ...(typeof resource.blob === 'string' ? { data: resource.blob } : {})
    }
  }
  if (block.type === 'resource_link') {
    return {
      ...(typeof block.mimeType === 'string' ? { contentType: block.mimeType } : {}),
      ...(typeof block.uri === 'string' ? { uri: block.uri } : {})
    }
  }
  return isJsonValue(block) ? block : null
}

export async function withMcpTimeout<T>(opts: { signal?: AbortSignal; timeoutMs?: number; scope: 'tool' }, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  opts.signal?.throwIfAborted()
  if (!opts.timeoutMs || opts.timeoutMs <= 0) return fn(opts.signal)
  const controller = new AbortController()
  const relay = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', relay, { once: true })
  if (opts.signal?.aborted) relay()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new OperationTimeoutError('MCP tool operation timed out.', { scope: opts.scope, timeout_ms: opts.timeoutMs as number })
      controller.abort(error)
      reject(error)
    }, opts.timeoutMs)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } catch (error) {
    if (controller.signal.aborted && !(controller.signal.reason instanceof OperationTimeoutError)) {
      throw new OperationCancelledError('MCP tool operation was cancelled.', { scope: 'tool' }, controller.signal.reason ?? error)
    }
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    opts.signal?.removeEventListener('abort', relay)
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function'
}

type LooseRecord = Record<string, unknown> & {
  aborted?: unknown
  addEventListener?: unknown
  blob?: unknown
  content?: unknown
  data?: unknown
  isError?: unknown
  mimeType?: unknown
  resource?: unknown
  structuredContent?: unknown
  text?: unknown
  toolResult?: unknown
  type?: unknown
  uri?: unknown
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isRecord(value)) return Object.values(value).every(isJsonValue)
  return false
}
