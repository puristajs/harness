import { isJsonValue, type JsonValue } from '../../models/json.js'
import type { McpServerDefinition, McpToolDefinition } from '../../definitions/types.js'
import type { McpBinding } from '../../runtime/instance-config.js'
import type { McpRequestHeaderContext } from '../../runtime/instance-config.js'
import type { SandboxProcess, SandboxSessionBase, SpawnCapableSandboxSession } from '../../sandbox/index.js'
import { isSpawnCapableSession } from '../../sandbox/index.js'
import { McpProtocolError, OperationCancelledError, OperationTimeoutError, SandboxNoExecutorError, ToolError } from '../../errors/index.js'
import { abortError, withAbortSignal } from '../../runtime/abort.js'
import { projectHarnessExecutionCaller } from '../../runtime/execution-caller.js'
import { projectModelSchema } from '../../schema/json-schema.js'
import { bindMcpTool, type ExecutableToolBinding } from '../bindings.js'
import { withMcpTimeout } from './timeout.js'
import { assertMcpJsonSchema } from './schema.js'

export interface McpRuntimeToolDescription {
	readonly name: string
	readonly inputSchema?: unknown
}

/** @internal Minimal protocol client seam; production SDK creation stays injectable and tests remain hermetic. */
export interface McpRuntimeClient {
	connect(transport: object, options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>): Promise<void>
	listTools(options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>): Promise<readonly McpRuntimeToolDescription[]>
	callTool(name: string, input: unknown, options: Readonly<{
		signal?: AbortSignal
		timeoutMs?: number
		headers?: Readonly<Record<string, string>>
	}>): Promise<unknown>
	/** Protocol owner closes its transport and any owned process. */
	close(): Promise<void>
}

/** @internal Explicit dependency seam used by H4-008 and fake-transport tests. */
export interface McpRuntimeDependencies {
	createClient(serverId: string): McpRuntimeClient | Promise<McpRuntimeClient>
	createHttpTransport(binding: Readonly<Omit<Extract<McpBinding, { transport: 'http' }>, 'resolveHeaders'>>): object | Promise<object>
	createStdioTransport(process: SandboxProcess): object
}

export interface McpRuntimeBundle {
	readonly serverId: string
	readonly tools: Readonly<Record<string, ExecutableToolBinding>>
	close(): Promise<void>
}

export interface InitializeMcpRuntimeOptions {
	readonly harnessName: string
	readonly harnessInstanceId: string
	readonly servers: Readonly<Record<string, McpServerDefinition<string, Record<string, McpToolDefinition>>>>
	readonly bindings: Readonly<Record<string, McpBinding>>
	readonly signal?: AbortSignal
	readonly timeoutMs: number
	readonly dependencies?: McpRuntimeDependencies
}

/** @internal Initializes all declared servers atomically in deterministic id order. */
export async function initializeMcpRuntimeBundles(options: InitializeMcpRuntimeOptions): Promise<readonly McpRuntimeBundle[]> {
	const dependencies = options.dependencies ?? defaultMcpRuntimeDependencies
	const bundles: McpRuntimeBundle[] = []
	try {
		for (const serverId of Object.keys(options.servers).sort()) {
			throwIfMcpAborted(options.signal, 'MCP initialization was cancelled.')
			const binding = options.bindings[serverId]
			if (binding === undefined) throw protocol(serverId, 'http', 'connect')
			bundles.push(await initializeServer(options.servers[serverId]!, binding, options, dependencies))
		}
		return Object.freeze(bundles)
	} catch (error) {
		for (const bundle of [...bundles].reverse()) await bundle.close().catch(() => undefined)
		throw error
	}
}

async function initializeServer(
	server: McpServerDefinition<string, Record<string, McpToolDefinition>>,
	binding: McpBinding,
	options: InitializeMcpRuntimeOptions,
	dependencies: McpRuntimeDependencies,
): Promise<McpRuntimeBundle> {
	let client: McpRuntimeClient
	try { client = await mcpOperation(options.signal, 'MCP initialization was cancelled.', () => dependencies.createClient(server.id)) }
	catch (error) {
		if (isOperationControlError(error)) throw error
		throw protocol(server.id, binding.transport, 'connect')
	}
	let attachment: SandboxSessionBase | undefined
	let stdioSandbox: Extract<McpBinding, { transport: 'stdio' }>['sandbox'] | undefined
	let scope: Parameters<NonNullable<typeof stdioSandbox>['terminate']>[0]['scope'] | undefined
	let protocolClosed = false
	let attachmentClosed = false
	let scopeTerminated = false
	const close = async () => {
		const failures: unknown[] = []
		if (!protocolClosed) { protocolClosed = true; try { await client.close() } catch (error) { failures.push(error) } }
		if (attachment !== undefined && !attachmentClosed) { attachmentClosed = true; try { await attachment.close() } catch (error) { failures.push(error) } }
		if (stdioSandbox !== undefined && scope !== undefined && !scopeTerminated) {
			scopeTerminated = true
			try { await stdioSandbox.terminate({ scope, reason: 'session_closed' }) } catch (error) { failures.push(error) }
		}
		if (failures.length > 0) throw new AggregateError(failures, 'MCP bundle cleanup failed.')
	}
	try {
		let transport: object
		if (binding.transport === 'http') {
			const transportBinding = Object.freeze({ transport: binding.transport, url: binding.url,
				...(binding.headers === undefined ? {} : { headers: binding.headers }) })
			transport = await mcpOperation(options.signal, 'MCP initialization was cancelled.', () => dependencies.createHttpTransport(transportBinding))
		} else {
			stdioSandbox = binding.sandbox
			const owner = { namespace: `${options.harnessName}.mcp`, id: server.id, instanceId: options.harnessInstanceId }
			scope = { owner, partition: { kind: 'shared' }, lifetime: 'session' }
			await mcpOperation(options.signal, 'MCP initialization was cancelled.', () => stdioSandbox!.registerOwner({ owner, mode: 'create', ...(options.signal ? { signal: options.signal } : {}) }))
			const opened = await mcpOperation(options.signal, 'MCP initialization was cancelled.', () => stdioSandbox!.open({ scope: scope!, mode: 'create', ...(options.signal ? { signal: options.signal } : {}) }))
			attachment = opened.session
			if (!isSpawnCapableSession(attachment)) throw new SandboxNoExecutorError('MCP stdio requires a spawn-capable sandbox session.', { session_id: server.id })
			const process = await mcpOperation(options.signal, 'MCP initialization was cancelled.', () => (attachment as SpawnCapableSandboxSession).spawn(binding.command, {
				...(binding.args ? { args: binding.args } : {}), ...(binding.env ? { env: { ...binding.env } } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			}))
			transport = dependencies.createStdioTransport(process)
		}
		try {
			await withMcpTimeout({ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: options.timeoutMs, scope: 'tool' }, signal => (
				client.connect(transport, { ...(signal ? { signal } : {}), timeoutMs: options.timeoutMs })
			))
		} catch (error) { throw mapInitializationError(error, server.id, binding.transport, 'connect', options.signal) }
		let discovered: readonly McpRuntimeToolDescription[]
		try {
			discovered = await withMcpTimeout({ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: options.timeoutMs, scope: 'tool' }, signal => (
				client.listTools({ ...(signal ? { signal } : {}), timeoutMs: options.timeoutMs })
			))
		} catch (error) { throw mapInitializationError(error, server.id, binding.transport, 'list', options.signal) }
		const tools: Record<string, ExecutableToolBinding> = {}
		for (const [localId, definition] of Object.entries(server.tools).sort(([a], [b]) => a.localeCompare(b))) {
			const candidates = discovered.filter(candidate => candidate.name === definition.remoteName)
			if (candidates.length !== 1 || candidates[0]!.inputSchema === undefined) throw protocol(localId, binding.transport, 'list')
			try { assertMcpJsonSchema(localId, candidates[0]!.inputSchema, 'mcp_input') }
			catch { throw protocol(localId, binding.transport, 'list') }
			const declared = normalizeSchema(projectModelSchema(definition.input, 'tool_input', localId), localId, binding.transport)
			const remote = normalizeSchema(candidates[0]!.inputSchema, localId, binding.transport)
			if (JSON.stringify(declared) !== JSON.stringify(remote)) throw protocol(localId, binding.transport, 'list')
			tools[localId] = bindMcpTool(definition, async (context, remoteName, input) => {
				const caller = projectHarnessExecutionCaller(context.caller)
				let headers: Readonly<Record<string, string>> | undefined
				if (binding.transport === 'http') {
					try {
						const resolverContext: McpRequestHeaderContext = Object.freeze({
							serverId: server.id, toolId: localId, sessionId: context.sessionId, runId: context.runId,
							caller, callId: context.callId,
							...(context.identity === undefined ? {} : { identity: context.identity }),
							signal: context.signal,
						})
						const resolved = binding.resolveHeaders === undefined ? undefined : await binding.resolveHeaders(resolverContext)
						headers = mergeMcpRequestHeaders(binding.headers, resolved)
					} catch (error) {
						if (isOperationControlError(error)) throw error
						if (context.signal.aborted) throw abortError(context.signal, 'tool', 'MCP tool operation was cancelled.')
						throw protocol(localId, binding.transport, 'call')
					}
				}
				let result: unknown
				try {
					result = await client.callTool(remoteName, input, {
						...(context.signal ? { signal: context.signal } : {}),
						...(headers === undefined ? {} : { headers }),
					})
				} catch (error) {
					if (isOperationControlError(error)) throw error
					if (context.signal?.aborted) throw abortError(context.signal, 'tool', 'MCP tool operation was cancelled.')
					throw protocol(localId, binding.transport, 'call')
				}
				return normalizeMcpOutput(result, localId, binding.transport)
			})
		}
		return Object.freeze({ serverId: server.id, tools: Object.freeze(tools), close })
	} catch (error) {
		await close().catch(() => undefined)
		throw error
	}
}

/** @internal Converts an MCP CallToolResult envelope into the declared tool output value. */
export function normalizeMcpOutput(result: unknown, toolId: string, transport: 'http' | 'stdio'): JsonValue {
	if (isPlain(result) && result['isError'] === true) {
		throw new ToolError('MCP tool returned an error.', { tool_id: toolId, tool_kind: `mcp_${transport}` })
	}
	if (isPlain(result) && isJsonValue(result['structuredContent'])) return result['structuredContent']
	if (!isPlain(result) || !Array.isArray(result['content'])) return isJsonValue(result) ? result : null

	const normalized = result['content'].map(normalizeContentBlock)
	if (normalized.length === 0) return null
	if (normalized.every(item => typeof item === 'string')) return normalized.join('\n')
	if (normalized.length === 1) return normalized[0] ?? null
	return Object.freeze({ content: normalized })
}

function mergeMcpRequestHeaders(
	staticHeaders: Readonly<Record<string, string>> | undefined,
	resolvedHeaders: unknown,
): Readonly<Record<string, string>> | undefined {
	if (resolvedHeaders !== undefined && !isPlain(resolvedHeaders)) throw new TypeError('MCP resolved headers are invalid.')
	const merged = new Map<string, readonly [name: string, value: string]>()
	for (const source of [staticHeaders, resolvedHeaders] as const) {
		if (source === undefined) continue
		const sourceNames = new Set<string>()
		for (const key of Object.keys(source).sort()) {
			const normalizedName = key.toLowerCase()
			if (sourceNames.has(normalizedName)) throw new TypeError('MCP resolved headers are invalid.')
			sourceNames.add(normalizedName)
			const value = source[key]
			if (typeof value !== 'string') throw new TypeError('MCP resolved headers are invalid.')
			merged.set(normalizedName, [key, value])
		}
	}
	if (merged.size === 0) return undefined
	const headers: Record<string, string> = {}
	for (const [, [name, value]] of [...merged].sort(([left], [right]) => left.localeCompare(right))) headers[name] = value
	return Object.freeze(headers)
}

function normalizeContentBlock(block: unknown): JsonValue {
	if (!isPlain(block)) return null
	if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text']
	if ((block['type'] === 'image' || block['type'] === 'audio') && typeof block['mimeType'] === 'string') {
		return Object.freeze({ contentType: block['mimeType'], ...(typeof block['data'] === 'string' ? { data: block['data'] } : {}) })
	}
	if (block['type'] === 'resource' && isPlain(block['resource'])) {
		const resource = block['resource']
		return Object.freeze({
			...(typeof resource['mimeType'] === 'string' ? { contentType: resource['mimeType'] } : {}),
			...(typeof resource['uri'] === 'string' ? { uri: resource['uri'] } : {}),
			...(typeof resource['text'] === 'string' ? { data: resource['text'] } : {}),
			...(typeof resource['blob'] === 'string' ? { data: resource['blob'] } : {}),
		})
	}
	if (block['type'] === 'resource_link') {
		return Object.freeze({
			...(typeof block['mimeType'] === 'string' ? { contentType: block['mimeType'] } : {}),
			...(typeof block['uri'] === 'string' ? { uri: block['uri'] } : {}),
		})
	}
	return isJsonValue(block) ? block : null
}

const defaultMcpRuntimeDependencies: McpRuntimeDependencies = Object.freeze({
	async createClient(serverId: string) {
		const { Client } = await import('@modelcontextprotocol/client')
		const sdk = new Client({ name: `purista-harness-${serverId}`, version: '0.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
		return {
			connect: async (transport: object, options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>) => sdk.connect(transport as never, { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) }),
			listTools: async (options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>) => (await sdk.listTools(undefined, { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) })).tools,
			callTool: async (name: string, input: unknown, options: Readonly<{ signal?: AbortSignal; timeoutMs?: number; headers?: Readonly<Record<string, string>> }>) => sdk.callTool(
				{ name, arguments: input as Record<string, unknown> },
				{ ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
					...(options.headers === undefined ? {} : { headers: options.headers }) },
			),
			close: async () => sdk.close(),
		}
	},
	async createHttpTransport(binding: Extract<McpBinding, { transport: 'http' }>) {
		const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
		return new StreamableHTTPClientTransport(new URL(binding.url), {
			requestInit: {
				redirect: 'error',
				...(binding.headers === undefined ? {} : { headers: { ...binding.headers } }),
			},
		})
	},
	createStdioTransport(process: SandboxProcess) { return createSandboxProcessTransport(process) },
})

/** @internal Creates the content-sanitizing transport used by the production stdio dependency. */
export function createSandboxProcessTransport(process: SandboxProcess): object {
	return new SandboxProcessTransport(process)
}

class SandboxProcessTransport {
	public onclose?: () => void
	public onerror?: (error: Error) => void
	public onmessage?: (message: unknown) => void
	private started = false
	private closed = false
	public constructor(private readonly process: SandboxProcess) {}
	public async start(): Promise<void> {
		if (this.started || this.closed) throw new Error('MCP stdio transport cannot be started.')
		this.started = true
		void this.consume()
		void this.drainStderr()
		void this.process.exit.then(() => {
			if (this.closed) return
			this.closed = true
			this.onclose?.()
		})
	}
	public async send(message: unknown): Promise<void> {
		if (!this.started || this.closed) throw new Error('MCP stdio transport is not active.')
		await this.process.writeStdin(`${JSON.stringify(message)}\n`)
	}
	public async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await this.process.kill('SIGTERM').catch(() => undefined)
		let timer: ReturnType<typeof setTimeout> | undefined
		const exited = await Promise.race([
			this.process.exit.then(() => true),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); timer.unref?.() }),
		])
		if (timer !== undefined) clearTimeout(timer)
		if (!exited) { await this.process.kill('SIGKILL').catch(() => undefined); await this.process.exit }
		this.onclose?.()
	}
	private async consume(): Promise<void> {
		let buffered = ''
		try {
			for await (const chunk of this.process.stdout) {
				buffered += chunk
				let newline = buffered.indexOf('\n')
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1)
					if (line) this.onmessage?.(JSON.parse(line))
					newline = buffered.indexOf('\n')
				}
			}
		} catch { this.onerror?.(new Error('MCP stdio stdout stream failed.')) }
	}
	private async drainStderr(): Promise<void> {
		try { for await (const _chunk of this.process.stderr) { /* drain without retaining content */ } }
		catch { this.onerror?.(new Error('MCP stdio stderr stream failed.')) }
	}
}

const ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples'])
const SUPPORTED = new Set([
	'$schema', 'additionalProperties', 'allOf', 'anyOf', 'const', 'enum', 'format', 'items', 'maximum',
	'maxItems', 'maxLength', 'minimum', 'minItems', 'minLength', 'not', 'oneOf', 'pattern', 'properties', 'required', 'type',
])

function normalizeSchema(value: unknown, toolId: string, transport: 'http' | 'stdio'): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
	if (Array.isArray(value)) return Object.freeze(value.map(item => normalizeSchema(item, toolId, transport))) as unknown as JsonValue
	if (!isPlain(value)) throw protocol(toolId, transport, 'list')
	const normalized: Record<string, JsonValue> = {}
	for (const key of Object.keys(value).filter(key => !ANNOTATIONS.has(key)).sort()) {
		if (!SUPPORTED.has(key)) throw protocol(toolId, transport, 'list')
		const child = value[key]
		if (key === 'format' && (typeof child !== 'string' || !['date-time', 'email', 'uri', 'uuid'].includes(child))) throw protocol(toolId, transport, 'list')
		if (key === 'required') {
			if (!Array.isArray(child) || child.some(item => typeof item !== 'string')) throw protocol(toolId, transport, 'list')
			normalized[key] = Object.freeze([...child].sort()) as unknown as JsonValue
		} else if (key === 'properties') {
			if (!isPlain(child)) throw protocol(toolId, transport, 'list')
			const properties: Record<string, JsonValue> = {}
			for (const property of Object.keys(child).sort()) properties[property] = normalizeSchema(child[property], toolId, transport)
			normalized[key] = Object.freeze(properties)
		} else normalized[key] = normalizeSchema(child, toolId, transport)
	}
	return Object.freeze(normalized)
}

function protocol(id: string, transport: 'http' | 'stdio', phase: 'connect' | 'list' | 'call'): McpProtocolError {
	return new McpProtocolError('MCP server contract validation failed.', { tool_id: id, transport, phase })
}

function mapInitializationError(
	error: unknown,
	id: string,
	transport: 'http' | 'stdio',
	phase: 'connect' | 'list',
	signal?: AbortSignal,
): Error {
	if (isOperationControlError(error)) return error
	if (signal?.aborted) return abortError(signal, 'tool', 'MCP initialization was cancelled.')
	return protocol(id, transport, phase)
}

function throwIfMcpAborted(signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted) throw abortError(signal, 'tool', message)
}

async function mcpOperation<T>(signal: AbortSignal | undefined, message: string, operation: () => T | Promise<T>): Promise<T> {
	try {
		return signal === undefined ? await operation() : await withAbortSignal(signal, 'tool', message, () => Promise.resolve(operation()))
	} catch (error) {
		if (isOperationControlError(error)) throw error
		if (error instanceof Error && error.name === 'AbortError') {
			throw new OperationCancelledError(message, { scope: 'tool' }, error)
		}
		throw error
	}
}

function isOperationControlError(error: unknown): error is OperationCancelledError | OperationTimeoutError {
	return error instanceof OperationCancelledError || error instanceof OperationTimeoutError
}

function isPlain(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
