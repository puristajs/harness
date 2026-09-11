import type { HarnessIdentity } from '../identity/index.js'
import type { ToolApprovalResume } from '../approvals/index.js'
import type { ExecutionEvent, ExecutionTerminalOutcome } from '../definitions/execution-events.js'
import type {
	HarnessInterruptKind,
	HarnessOutputUpdateKind,
	HarnessTargetContract,
	HarnessTargetKind,
} from '../definitions/types.js'
import type { JsonValue } from '../models/json.js'
import type { ModelSchema } from '../schema/index.js'
import type { HarnessTraceContext } from '../telemetry/trace-context.js'
import type { HarnessInterrupt } from '../runtime/outcomes.js'

export type AnyHarnessTargetContract = HarnessTargetContract<
	HarnessTargetKind,
	string,
	ModelSchema,
	ModelSchema,
	HarnessOutputUpdateKind,
	readonly HarnessInterruptKind[],
	any
>
export type HarnessTargetInput<T> = T extends AnyHarnessTargetContract ? T['$infer']['input'] : never
export type HarnessValidatedTargetInput<T> = T extends AnyHarnessTargetContract ? T['$infer']['validatedInput'] : never
export type HarnessTargetOutput<T> = T extends AnyHarnessTargetContract ? T['$infer']['output'] : never
export type HarnessTargetInterrupt<T> = T extends AnyHarnessTargetContract ? T['$infer']['interrupt'] : never

type HarnessTargetDispatchInvocationBase = Readonly<{
		sessionId: string
		invocationId: string
		rootRunId: string
		parentRunId: string
		depth: number
		remainingDepth: number
		identity?: HarnessIdentity
		trace?: HarnessTraceContext
		deadline?: number
		idempotencyKey?: string
		signal: AbortSignal
}>

/** Runtime-authored correlation, ancestry, identity, and lifecycle for one nested target. */
export type HarnessNestedTargetDispatchInvocation = Readonly<HarnessTargetDispatchInvocationBase & (
		| Readonly<{ parentAgentId: string; parentWorkflowId?: never }>
		| Readonly<{ parentAgentId?: never; parentWorkflowId: string }>
	)>

/** Runtime-authored invocation for either a root receiver or one nested target. */
export type HarnessRootTargetDispatchInvocation = Readonly<HarnessTargetDispatchInvocationBase & {
	parentAgentId?: never
	parentWorkflowId?: never
}>
export type HarnessTargetDispatchInvocation =
	| HarnessNestedTargetDispatchInvocation
	| HarnessRootTargetDispatchInvocation

/** Trusted transport-neutral request for one Harness target. */
export type HarnessTargetDispatchRequest<Target extends AnyHarnessTargetContract> = Readonly<{
	target: Target
	input: HarnessTargetInput<Target>
	invocation: HarnessNestedTargetDispatchInvocation
}>

export interface HarnessTargetDispatchStream<Output, Interrupt> extends AsyncIterable<ExecutionEvent<Output, Interrupt>> {
	readonly result: Promise<ExecutionTerminalOutcome<Output, Interrupt>>
	cancel(reason?: string): Promise<void>
}

/** Stable inert receipt for one exact target route owned by a dispatcher. */
export interface HarnessTargetRouteReceiptV1 {
	readonly schemaVersion: 1
	readonly kind: 'harness_target_route'
	readonly target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
	readonly bindingDigest: string
}

/** Persisted child-target resume request accepted only by the owning dispatcher route. */
export type PersistedHarnessTargetDispatchRequest = Readonly<{
	route: HarnessTargetRouteReceiptV1
	wireInput: JsonValue
	resume: ToolApprovalResume
	invocation: HarnessNestedTargetDispatchInvocation
}>

/** Runtime/integrator SPI for identity-first local or remote target dispatch. */
export interface HarnessTargetDispatcher {
	/** Fails unless the exact immutable target contract is registered, then returns its inert route receipt. */
	assertTarget(target: AnyHarnessTargetContract): HarnessTargetRouteReceiptV1
	open<Target extends AnyHarnessTargetContract>(request: HarnessTargetDispatchRequest<Target>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>, HarnessTargetInterrupt<Target>>>
	/** Resumes one persisted child route only when the complete stored receipt still matches. */
	openPersisted(request: PersistedHarnessTargetDispatchRequest): Promise<HarnessTargetDispatchStream<JsonValue, HarnessInterrupt>>
}
