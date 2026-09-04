import type { HarnessIdentity } from '../identity/index.js'
import type { ExecutionEvent } from '../definitions/execution-events.js'
import type {
	HarnessInterruptKind,
	HarnessOutputUpdateKind,
	HarnessTargetContract,
	HarnessTargetKind,
} from '../definitions/types.js'
import type { JsonValue } from '../models/json.js'
import type { Infer, InferIn, ModelSchema } from '../schema/index.js'
import type { HarnessTraceContext } from '../telemetry/trace-context.js'

export type AnyHarnessTargetContract = HarnessTargetContract<
	HarnessTargetKind,
	string,
	ModelSchema,
	ModelSchema,
	HarnessOutputUpdateKind,
	readonly HarnessInterruptKind[]
>
export type HarnessTargetInput<T> = T extends HarnessTargetContract<HarnessTargetKind, string, infer I, ModelSchema, HarnessOutputUpdateKind, readonly HarnessInterruptKind[]> ? InferIn<I> & JsonValue : never
export type HarnessValidatedTargetInput<T> = T extends HarnessTargetContract<HarnessTargetKind, string, infer I, ModelSchema, HarnessOutputUpdateKind, readonly HarnessInterruptKind[]> ? Infer<I> & JsonValue : never
export type HarnessTargetOutput<T> = T extends HarnessTargetContract<HarnessTargetKind, string, ModelSchema, infer O, HarnessOutputUpdateKind, readonly HarnessInterruptKind[]> ? Infer<O> & JsonValue : never

/** Trusted transport-neutral request for one Harness target. */
export type HarnessTargetDispatchRequest<Target extends AnyHarnessTargetContract> = Readonly<{
	target: Target
	input: HarnessTargetInput<Target>
	invocation: Readonly<{
		sessionId: string
		invocationId: string
		rootRunId: string
		parentRunId: string
		parentAgentId?: string
		parentWorkflowId?: string
		depth: number
		remainingDepth: number
		identity?: HarnessIdentity
		trace?: HarnessTraceContext
		deadline?: number
		idempotencyKey?: string
		signal: AbortSignal
	}>
}>

export interface HarnessTargetDispatchStream<Output> extends AsyncIterable<ExecutionEvent<Output>> {
	cancel(reason?: string): Promise<void>
}

/** Runtime/integrator SPI for identity-first local or remote target dispatch. */
export interface HarnessTargetDispatcher {
	open<Target extends AnyHarnessTargetContract>(request: HarnessTargetDispatchRequest<Target>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
}
