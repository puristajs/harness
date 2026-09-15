import type { HarnessIdentity } from '../identity/index.js'
import type { JsonValue } from '../models/json.js'
import type {
	HarnessExecutionCaller,
	ToolDefinition,
	ToolHandlerContext,
	ToolHandlerContextBase,
	ToolMemoryFacade,
	ToolRequirements,
	ToolSandboxFacade,
} from '../definitions/types.js'
import type { MemoryCapability } from '../ports/memory/types.js'
import type { SandboxCapabilityId } from '../definitions/types.js'
import { createMetrics, type Metrics, type TelemetryShim } from '../telemetry/index.js'
import { FakeLogger } from './fakeLogger.js'
import { RecordingTelemetry } from './recordingTelemetry.js'

type RequirementsOf<Tool> = Tool extends ToolDefinition<any, any, any, infer Requirements> ? Requirements : never
type MemoryOptions<Requirements extends ToolRequirements> = Requirements extends {
	readonly memory: infer Capabilities extends readonly MemoryCapability[]
} ? Readonly<{ memory: ToolMemoryFacade<Capabilities> }> : Readonly<{ memory?: never }>
type SandboxOptions<Requirements extends ToolRequirements> = Requirements extends {
	readonly sandbox: infer Capabilities extends readonly SandboxCapabilityId[]
} ? Readonly<{ sandbox: ToolSandboxFacade<Capabilities> }> : Readonly<{ sandbox?: never }>

/** Overrides accepted by {@link createToolTestContext}. Required capability facades follow the Tool definition. */
export type ToolTestContextOptions<
	Tool extends ToolDefinition<any, any, any, any>,
> = Readonly<{
	caller?: HarnessExecutionCaller
	signal?: AbortSignal
	logger?: ToolHandlerContextBase['logger']
	metrics?: Metrics
	telemetry?: TelemetryShim
	identity?: HarnessIdentity
	sessionId?: string
	runId?: string
	callId?: string
	invocationId?: string
	idempotencyKey?: string
	metadata?: Readonly<Record<string, JsonValue>>
}> & MemoryOptions<RequirementsOf<Tool>> & SandboxOptions<RequirementsOf<Tool>>

type ContextOptionsArgument<Tool extends ToolDefinition<any, any, any, any>> =
	RequirementsOf<Tool> extends { readonly memory: readonly MemoryCapability[] } | { readonly sandbox: readonly SandboxCapabilityId[] }
		? readonly [options: ToolTestContextOptions<Tool>]
		: readonly [options?: ToolTestContextOptions<Tool>]

/** Exact Tool handler context produced for a definition, including its literal Tool id. */
export type ToolTestContext<Tool extends ToolDefinition<any, any, any, any>> =
	ToolHandlerContext<RequirementsOf<Tool>> & Readonly<{ toolId: Tool['id'] }>

/**
 * Creates a deterministic, capability-aware context for calling one portable Tool handler directly.
 *
 * @example
 * ```ts
 * const context = createToolTestContext(lookup)
 * await expect(lookup.handler(context, { id: 'order-1' })).resolves.toEqual({ status: 'ready' })
 * ```
 */
export function createToolTestContext<Tool extends ToolDefinition<any, any, any, any>>(
	tool: Tool,
	...args: ContextOptionsArgument<Tool>
): ToolTestContext<Tool> {
	const options = args[0] ?? {} as ToolTestContextOptions<Tool>
	const telemetry = options.telemetry ?? new RecordingTelemetry()
	return Object.freeze({
		caller: options.caller ?? Object.freeze({ kind: 'agent' as const, agentId: 'testAgent' }),
		signal: options.signal ?? new AbortController().signal,
		logger: options.logger ?? new FakeLogger(),
		metrics: options.metrics ?? createMetrics(telemetry),
		telemetry,
		...(options.identity === undefined ? {} : { identity: Object.freeze({ ...options.identity }) }),
		sessionId: options.sessionId ?? 'testSession',
		runId: options.runId ?? 'testRun',
		toolId: tool.id,
		callId: options.callId ?? 'testCall',
		invocationId: options.invocationId ?? 'testInvocation',
		...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
		metadata: options.metadata ?? Object.freeze({}),
		...('memory' in options ? { memory: options.memory } : {}),
		...('sandbox' in options ? { sandbox: options.sandbox } : {}),
	}) as ToolTestContext<Tool>
}
