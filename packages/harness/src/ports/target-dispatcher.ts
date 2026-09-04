import type { HarnessIdentity } from '../identity/index.js'
import type { ExecutionEvent } from '../definitions/execution-events.js'
import type { HarnessTargetContract } from '../definitions/types.js'
import type { Infer, InferIn, ModelSchema } from '../schema/index.js'
import type { HarnessTraceContext } from '../telemetry/trace-context.js'

type AnyTarget = HarnessTargetContract<any, any, ModelSchema, ModelSchema, any, any>
type TargetInput<T> = T extends HarnessTargetContract<any, any, infer I, any, any, any> ? InferIn<I> : never
type TargetOutput<T> = T extends HarnessTargetContract<any, any, any, infer O, any, any> ? Infer<O> : never

/** Trusted transport-neutral request for one Harness target. */
export type HarnessTargetDispatchRequest<Target extends AnyTarget> = Readonly<{
	target: Target
	input: TargetInput<Target>
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
	open<Target extends AnyTarget>(request: HarnessTargetDispatchRequest<Target>): Promise<HarnessTargetDispatchStream<TargetOutput<Target>>>
}
