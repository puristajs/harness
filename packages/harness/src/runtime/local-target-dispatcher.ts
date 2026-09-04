import type { AnyAgentDefinition, AnyWorkflowDefinition, HarnessTargetContract } from '../definitions/types.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import { HarnessConfigError, ValidationError } from '../errors/index.js'
import { normalizeHarnessIdentity } from '../identity/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type {
	AnyHarnessTargetContract,
	HarnessTargetDispatcher,
	HarnessTargetDispatchRequest,
	HarnessTargetDispatchStream,
	HarnessTargetOutput,
	HarnessValidatedTargetInput,
} from '../ports/target-dispatcher.js'
import { validateSchema } from '../schema/validation.js'
import { normalizeHarnessTraceContext } from '../telemetry/trace-context.js'
import { withAbortSignal } from './abort.js'

type AnyDefinition = AnyAgentDefinition | AnyWorkflowDefinition
type ContractOf<D extends AnyDefinition> = D['contract']

/** Receiving-boundary request supplied only to a registered local target executor. */
export type LocalTargetExecutionRequest<D extends AnyDefinition> = Readonly<{
	definition: D
	input: HarnessValidatedTargetInput<ContractOf<D>>
	invocation: HarnessTargetDispatchRequest<ContractOf<D>>['invocation']
}>

/** One immutable local route from an exact definition identity to its executor. */
export interface LocalTargetBinding<D extends AnyDefinition = AnyDefinition> {
	readonly definition: D
	execute(request: LocalTargetExecutionRequest<D>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<ContractOf<D>>>>
}

export interface LocalTargetDispatcherOptions {
	readonly defaultMaxDepth: number
	readonly bindings: readonly LocalTargetBinding[]
}

interface LocalRoute {
	readonly definition: AnyDefinition
	readonly contract: AnyHarnessTargetContract
	readonly configuredMaxDepth: number
	execute(input: JsonValue, invocation: HarnessTargetDispatchRequest<AnyHarnessTargetContract>['invocation']): Promise<HarnessTargetDispatchStream<JsonValue>>
}

/** Creates a standalone receiving dispatcher with no string-address fallback. */
export function createLocalTargetDispatcher(options: LocalTargetDispatcherOptions): HarnessTargetDispatcher {
	if (!Number.isSafeInteger(options.defaultMaxDepth) || options.defaultMaxDepth < 0 || !Array.isArray(options.bindings)) {
		throw new HarnessConfigError('Local target dispatcher configuration is invalid.', {
			reason: 'invalid_target_dispatcher', path: 'targetDispatcher',
		})
	}
	const routes = new Map<object, LocalRoute>()
	for (const binding of options.bindings) {
		const identity = getDefinitionIdentity(binding.definition)
		const contractIdentity = getDefinitionIdentity(binding.definition.contract)
		if (identity === undefined || contractIdentity?.token !== identity.token || (identity.kind !== 'agent' && identity.kind !== 'workflow')) {
			throw foreignDefinition()
		}
		if (routes.has(identity.token)) throw new HarnessConfigError('Local target dispatcher contains a duplicate definition.', {
			reason: 'duplicate_definition', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		if (typeof binding.execute !== 'function') throw new HarnessConfigError('Local target executor is invalid.', {
			reason: 'invalid_target_dispatcher', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		const configuredMaxDepth = binding.definition.kind === 'agent'
			? binding.definition.loop?.maxDepth ?? options.defaultMaxDepth
			: binding.definition.maxDepth ?? options.defaultMaxDepth
		routes.set(identity.token, eraseLocalBinding(binding, configuredMaxDepth))
	}

	return Object.freeze({
		async open<Target extends AnyHarnessTargetContract>(request: HarnessTargetDispatchRequest<Target>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>> {
			const identity = getDefinitionIdentity(request.target)
			const route = identity === undefined ? undefined : routes.get(identity.token)
			if (route === undefined || route.contract !== request.target) throw foreignDefinition()
			validateInvocation(request.invocation)
			const where = route.definition.kind === 'agent' ? 'agent_input' : 'workflow_input'
			const input = await withAbortSignal(request.invocation.signal, route.definition.kind, 'Target input validation was cancelled.', () => validateSchema(route.definition.input, request.input, {
				where, message: route.definition.kind === 'agent' ? 'Agent input validation failed.' : 'Workflow input validation failed.',
			}))
			if (!isJsonValue(input)) throw new ValidationError('Target input validation failed.', {
				where, issues: { reason: 'non_json_target_input' },
			})
			const identityValue = normalizeHarnessIdentity(request.invocation.identity)
			const trace = request.invocation.trace === undefined ? undefined : normalizeHarnessTraceContext(request.invocation.trace)
			const invocation = Object.freeze({ ...request.invocation,
				remainingDepth: Math.min(request.invocation.remainingDepth, route.configuredMaxDepth),
				...(identityValue === undefined ? {} : { identity: identityValue }),
				...(trace === undefined ? {} : { trace }),
			})
			const opened = await withAbortSignal(request.invocation.signal, route.definition.kind, 'Target dispatch was cancelled.', () => route.execute(input, invocation))
			return opened as HarnessTargetDispatchStream<HarnessTargetOutput<Target>>
		},
	})
}

function eraseLocalBinding<D extends AnyDefinition>(binding: LocalTargetBinding<D>, configuredMaxDepth: number): LocalRoute {
	const contract = binding.definition.contract
	return Object.freeze({
		definition: binding.definition,
		contract,
		configuredMaxDepth,
		async execute(input: JsonValue, invocation: HarnessTargetDispatchRequest<AnyHarnessTargetContract>['invocation']) {
			const typedInput = input as HarnessValidatedTargetInput<ContractOf<D>>
			const opened = await binding.execute(Object.freeze({ definition: binding.definition, input: typedInput, invocation }))
			return opened as HarnessTargetDispatchStream<JsonValue>
		},
	})
}

function validateInvocation(invocation: HarnessTargetDispatchRequest<AnyHarnessTargetContract>['invocation']): void {
	for (const [path, value] of [['depth', invocation.depth], ['remainingDepth', invocation.remainingDepth]] as const) {
		if (!Number.isSafeInteger(value) || value < 0) throw new HarnessConfigError('Target dispatch invocation is invalid.', {
			reason: 'invalid_target_dispatch', path: `targetDispatcher.invocation.${path}`,
		})
	}
	for (const [path, value] of [['sessionId', invocation.sessionId], ['invocationId', invocation.invocationId], ['rootRunId', invocation.rootRunId], ['parentRunId', invocation.parentRunId]] as const) {
		if (typeof value !== 'string' || value.length === 0) throw new HarnessConfigError('Target dispatch invocation is invalid.', {
			reason: 'invalid_target_dispatch', path: `targetDispatcher.invocation.${path}`,
		})
	}
}

function foreignDefinition(): HarnessConfigError {
	return new HarnessConfigError('Target contract is not registered with this dispatcher.', {
		reason: 'foreign_definition', path: 'targetDispatcher.target',
	})
}
