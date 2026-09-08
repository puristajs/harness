import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import {
	createHostOwnerToken, defineHostTool, instantiateHostedHarness,
	type HarnessHostBindings, type HostedHarnessInstanceConfig, type HostedInvokeOptions,
} from '../src/integrator/index.js'
import type { ModelProvider } from '../src/ports/model-provider.js'
import type { HarnessTargetDispatcher } from '../src/ports/target-dispatcher.js'
import type { HarnessTargetDispatchStream } from '../src/ports/target-dispatcher.js'
import type { HarnessTargetStream } from '../src/definitions/execution-events.js'
import type { HarnessTargetRunOutcome } from '../src/runtime/outcomes.js'
import type { HarnessStorage } from '../src/storage/types.js'
import type { Logger } from '../src/logger/index.js'
import type { TelemetryShim } from '../src/telemetry/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

type HostContext = Readonly<{ tenantId: string }>
const owner = createHostOwnerToken<HostContext>()
const lookup = defineHostTool(owner, 'lookupAccount', {
	description: 'Look up an account.',
	input: z.object({ accountId: z.string() }),
	output: z.object({ balance: z.number() }),
	async handler(context, input) {
		const tenantId: string = context.tenantId
		const accountId: string = input.accountId
		void tenantId
		void accountId
		return { balance: 1 }
	},
})
const agent = defineAgent('accountAssistant', { instructions: 'Help.', tools: [lookup] })
const workflow = defineWorkflow('hostedWorkflow', { input: z.string(), output: z.number(),
	async handler({ input }) { return input.length } })
const harness = defineHarness({ name: 'hosted', revision: 'v1' }).addAgent(agent).addWorkflow(workflow)

declare const provider: ModelProvider
declare const storage: HarnessStorage
const config: HostedHarnessInstanceConfig<typeof harness.requirements> = {
	model: { provider, model: 'model' },
	storage,
}
void config

const options: HostedInvokeOptions = { sessionId: 'session' }
void options
// @ts-expect-error trace context is owned by the host boundary
const callerTrace: HostedInvokeOptions = { sessionId: 'session', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
void callerTrace
const callerLogger: HostedHarnessInstanceConfig<typeof harness.requirements> = {
	model: { provider, model: 'model' }, storage,
	// @ts-expect-error hosted runtime configuration cannot replace the host logger
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
}
void callerLogger
const callerTelemetry: HostedHarnessInstanceConfig<typeof harness.requirements> = {
	model: { provider, model: 'model' }, storage,
	// @ts-expect-error hosted runtime configuration cannot replace host telemetry
	telemetry: {} as TelemetryShim,
}
void callerTelemetry

// @ts-expect-error host-aware graphs require persistent storage in hosted configuration
const missingStorage: HostedHarnessInstanceConfig<typeof harness.requirements> = { model: { provider, model: 'model' } }
void missingStorage

declare const dispatcher: HarnessTargetDispatcher
declare const logger: Logger
declare const telemetry: TelemetryShim
const hostBindings: HarnessHostBindings<Readonly<{ authorization: string }>, HostContext> = {
	hostOwner: owner, targetDispatcher: dispatcher,
	projectIdentity: () => ({ tenantId: 'tenant' }), projectTraceContext: () => undefined,
	createHostContext: () => ({ tenantId: 'tenant' }), logger, telemetry,
}
const hostedInstance = instantiateHostedHarness(harness, config, hostBindings)
hostedInstance.then(instance => {
	const agentRun = instance.runHosted({ target: agent.contract, input: 'hello', invokeOptions: { sessionId: 'session' },
		hostInvocation: { authorization: 'token' } })
	const workflowRun = instance.runHosted({ target: workflow.contract, input: 'hello', invokeOptions: { sessionId: 'session' },
		hostInvocation: { authorization: 'token' } })
	const agentStream = instance.streamHosted({ target: agent.contract, input: 'hello', invokeOptions: { sessionId: 'stream-session' },
		hostInvocation: { authorization: 'token' } })
	const dispatchedStream = instance.streamDispatched({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 'hello', invocation: {
		sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
		parentAgentId: 'parent-agent', depth: 1, remainingDepth: 1, signal: new AbortController().signal,
	}, hostInvocation: { authorization: 'token' } })
	type _AgentRun = Expect<Equal<typeof agentRun, Promise<HarnessTargetRunOutcome<typeof agent.contract>>>>
	type _WorkflowRun = Expect<Equal<typeof workflowRun, Promise<HarnessTargetRunOutcome<typeof workflow.contract>>>>
	type _AgentStream = Expect<Equal<typeof agentStream, Promise<HarnessTargetStream<typeof agent.contract>>>>
	type _DispatchedStream = Expect<Equal<typeof dispatchedStream,
		Promise<HarnessTargetDispatchStream<typeof agent.contract.$infer.output, typeof agent.contract.$infer.interrupt>>>>
	instance.streamDispatched({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 'hello',
		// @ts-expect-error a dispatched child has exactly one parent target kind
		invocation: { sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
			depth: 1, remainingDepth: 1, signal: new AbortController().signal },
		hostInvocation: { authorization: 'token' } })
	instance.streamDispatched({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 'hello',
		// @ts-expect-error agent and workflow ancestry are mutually exclusive
		invocation: { sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
			parentAgentId: 'agent', parentWorkflowId: 'workflow', depth: 1, remainingDepth: 1,
			signal: new AbortController().signal },
		hostInvocation: { authorization: 'token' } })
	// @ts-expect-error a resume delivery has no already transformed logical input
	instance.streamDispatched({ delivery: 'resume', target: agent.contract, wireInput: 'hello', input: 'hello', invocation: {
		sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
		parentAgentId: 'parent-agent', depth: 1, remainingDepth: 1, signal: new AbortController().signal,
	}, resume: { type: 'tool-approval', runId: 'child-run', interruptId: 'interrupt', revision: 'revision',
		eventId: 'event', decisions: [] }, hostInvocation: { authorization: 'token' } })
	instance.streamDispatched({ delivery: 'resume', target: agent.contract, wireInput: 'hello', invocation: {
		sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
		parentAgentId: 'parent-agent', depth: 1, remainingDepth: 1, signal: new AbortController().signal,
	}, resume: { type: 'tool-approval', runId: 'child-run', interruptId: 'interrupt', revision: 'revision',
		eventId: 'event', decisions: [] }, hostInvocation: { authorization: 'token' } })
	instance.streamDispatched({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 'hello', invocation: {
		sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root-run', parentRunId: 'parent-run',
		parentAgentId: 'parent-agent', depth: 1, remainingDepth: 1, signal: new AbortController().signal,
		// @ts-expect-error dispatched identity is projected from HostInvocation
		identity: { tenantId: 'caller-controlled' },
	}, hostInvocation: { authorization: 'token' } })
	// @ts-expect-error hosted targets are exact contracts mounted in this Harness
	instance.runHosted({ target: defineAgent('outsideAgent', { instructions: 'Outside.' }).contract, input: 'hello',
		invokeOptions: { sessionId: 'session' }, hostInvocation: { authorization: 'token' } })
	// @ts-expect-error agent input is the exact validated logical input
	instance.runHosted({ target: agent.contract, input: 1, invokeOptions: { sessionId: 'session' },
		hostInvocation: { authorization: 'token' } })
	// @ts-expect-error workflow output typing does not change its string input contract
	instance.streamHosted({ target: workflow.contract, input: 1, invokeOptions: { sessionId: 'session' },
		hostInvocation: { authorization: 'token' } })
	// @ts-expect-error HostInvocation is required and exact at the hosted boundary
	instance.runHosted({ target: agent.contract, input: 'hello', invokeOptions: { sessionId: 'session' }, hostInvocation: {} })
	// @ts-expect-error hosted targets are contracts, not string ids
	instance.runHosted({ target: 'accountAssistant', input: 'hello', invokeOptions: { sessionId: 'session' },
		hostInvocation: { authorization: 'token' } })
})

// @ts-expect-error ordinary getInstance never accepts host-owned binding maps
harness.getInstance({ model: { provider, model: 'model' }, storage, hostTools: { lookupAccount: lookup.handler } })
defineHostTool(createHostOwnerToken<{ wrong: true }>(), 'badContext', {
	description: 'Bad.', input: z.string(), output: z.string(),
	// @ts-expect-error owner context determines the host tool handler context
	handler: lookup.handler,
})
