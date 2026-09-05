import { createHash } from 'node:crypto'

import type { ToolApprovalResume } from '../approvals/index.js'
import type { AnyAgentDefinition, AnyWorkflowDefinition } from '../definitions/types.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import { HarnessConfigError, HarnessTargetRouteReceiptMismatchError, ValidationError } from '../errors/index.js'
import { normalizeHarnessIdentity } from '../identity/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type {
	AnyHarnessTargetContract,
	HarnessTargetDispatcher,
	HarnessRootTargetDispatchInvocation,
	HarnessTargetDispatchInvocation,
	HarnessTargetDispatchRequest,
	HarnessTargetDispatchStream,
	HarnessTargetOutput,
	HarnessTargetRouteReceiptV1,
	HarnessValidatedTargetInput,
	PersistedHarnessTargetDispatchRequest,
} from '../ports/target-dispatcher.js'
import { validateSchema } from '../schema/validation.js'
import { normalizeHarnessTraceContext } from '../telemetry/trace-context.js'
import { withAbortSignal } from './abort.js'
import { canonicalJson } from './canonical-json.js'

type AnyDefinition = AnyAgentDefinition | AnyWorkflowDefinition
type ContractOf<D extends AnyDefinition> = D['contract']

/** Receiving-boundary request supplied only to a registered local target executor. */
type LocalTargetExecutionRequestBase<D extends AnyDefinition> = Readonly<{
	definition: D
	/** Canonical pre-transform wire input retained for durable replay checks. */
	wireInput: JsonValue
	invocation: HarnessTargetDispatchInvocation
}>
export type LocalTargetExecutionRequest<D extends AnyDefinition> =
	| Readonly<LocalTargetExecutionRequestBase<D> & {
		delivery: 'fresh'
		input: HarnessValidatedTargetInput<ContractOf<D>>
	}>
	| Readonly<LocalTargetExecutionRequestBase<D> & {
		delivery: 'resume'
		resume: ToolApprovalResume
	}>

/** One immutable local route from an exact definition identity to its executor. */
export interface LocalTargetBinding<D extends AnyDefinition = AnyDefinition> {
	readonly definition: D
	execute(request: LocalTargetExecutionRequest<D>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<ContractOf<D>>>>
}

export interface LocalTargetDispatcherOptions {
	readonly defaultMaxDepth: number
	/** Deployment revision plus compiled graph digest for this immutable route table. */
	readonly routeBindingRevision: string
	readonly bindings: readonly LocalTargetBinding[]
}

/** Package-private root receiving seam used before any nested dispatcher exists. */
export interface LocalTargetDispatcher extends HarnessTargetDispatcher {
	openRoot<Target extends AnyHarnessTargetContract>(request: Readonly<{
		target: Target
		input: import('../ports/target-dispatcher.js').HarnessTargetInput<Target>
		invocation: HarnessRootTargetDispatchInvocation
	}>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
}

interface LocalRoute {
	readonly definition: AnyDefinition
	readonly contract: AnyHarnessTargetContract
	readonly configuredMaxDepth: number
	readonly receipt: HarnessTargetRouteReceiptV1
	execute(request: LocalTargetExecutionRequest<AnyDefinition>): Promise<HarnessTargetDispatchStream<JsonValue>>
}

/** Creates a standalone receiving dispatcher with no string-address fallback. */
export function createLocalTargetDispatcher(options: LocalTargetDispatcherOptions): LocalTargetDispatcher {
	const revisionValid = validRouteRevision(options.routeBindingRevision)
	if (!Number.isSafeInteger(options.defaultMaxDepth) || options.defaultMaxDepth < 0 || !Array.isArray(options.bindings) || !revisionValid) {
		throw new HarnessConfigError('Local target dispatcher configuration is invalid.', {
			reason: 'invalid_target_dispatcher', path: revisionValid ? 'targetDispatcher' : 'targetDispatcher.routeBindingRevision',
		})
	}
	const routes = new Map<object, LocalRoute>()
	const routesByReceipt = new Map<string, LocalRoute>()
	const bindingDigests = new Set<string>()
	const logicalRoutes = new Set<string>()
	for (const binding of options.bindings) {
		const identity = getDefinitionIdentity(binding.definition)
		const contractIdentity = getDefinitionIdentity(binding.definition.contract)
		if (identity === undefined || contractIdentity?.token !== identity.token || (identity.kind !== 'agent' && identity.kind !== 'workflow')) {
			throw foreignDefinition()
		}
		if (routes.has(identity.token)) throw new HarnessConfigError('Local target dispatcher contains a duplicate definition.', {
			reason: 'duplicate_definition', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		const logicalRoute = `${identity.kind}:${identity.id}`
		if (logicalRoutes.has(logicalRoute)) throw new HarnessConfigError('Local target dispatcher contains a duplicate logical route.', {
			reason: 'duplicate_definition', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		if (typeof binding.execute !== 'function') throw new HarnessConfigError('Local target executor is invalid.', {
			reason: 'invalid_target_dispatcher', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		const configuredMaxDepth = binding.definition.kind === 'agent'
			? binding.definition.loop?.maxDepth ?? options.defaultMaxDepth
			: binding.definition.maxDepth ?? options.defaultMaxDepth
		const receipt = createRouteReceipt(identity.kind, identity.id, options.routeBindingRevision)
		const route = eraseLocalBinding(binding, configuredMaxDepth, receipt)
		const receiptBytes = canonicalJson(receipt)
		if (routesByReceipt.has(receiptBytes) || bindingDigests.has(receipt.bindingDigest)) throw new HarnessConfigError('Local target dispatcher contains a duplicate route receipt.', {
			reason: 'duplicate_definition', path: `targetDispatcher.${identity.kind}.${identity.id}`,
		})
		routes.set(identity.token, route)
		routesByReceipt.set(receiptBytes, route)
		bindingDigests.add(receipt.bindingDigest)
		logicalRoutes.add(logicalRoute)
	}

	const assertTarget = (target: AnyHarnessTargetContract): LocalRoute => {
		const identity = getDefinitionIdentity(target)
		const route = identity === undefined ? undefined : routes.get(identity.token)
		if (route === undefined || route.contract !== target) throw foreignDefinition()
		return route
	}
	const openRoute = async (
		route: LocalRoute,
		inputValue: JsonValue,
		invocationValue: HarnessTargetDispatchInvocation,
		resume?: ToolApprovalResume,
		ancestry: 'root' | 'nested' = 'nested',
	): Promise<HarnessTargetDispatchStream<JsonValue>> => {
		validateInvocation(invocationValue, ancestry)
		if (resume !== undefined && resume.runId !== invocationValue.invocationId) {
			throw new HarnessConfigError('Persisted target resume is invalid.', {
				reason: 'invalid_target_dispatch', path: 'targetDispatcher.resume.runId',
			})
		}
		const where = route.definition.kind === 'agent' ? 'agent_input' : 'workflow_input'
		const input = await withAbortSignal(invocationValue.signal, route.definition.kind, 'Target input validation was cancelled.', () => validateSchema(route.definition.input, inputValue, {
			where, message: route.definition.kind === 'agent' ? 'Agent input validation failed.' : 'Workflow input validation failed.',
		}))
		if (!isJsonValue(input)) throw new ValidationError('Target input validation failed.', {
			where, issues: { reason: 'non_json_target_input' },
		})
		const invocation = normalizeInvocation(invocationValue, route.configuredMaxDepth)
		return withAbortSignal(invocationValue.signal, route.definition.kind, 'Target dispatch was cancelled.', () => route.execute(Object.freeze({
			delivery: 'fresh' as const, definition: route.definition, input, wireInput: inputValue, invocation,
		})))
	}

	return Object.freeze({
		assertTarget(target: AnyHarnessTargetContract): HarnessTargetRouteReceiptV1 { return assertTarget(target).receipt },
		async openRoot<Target extends AnyHarnessTargetContract>(request: Readonly<{ target: Target; input: import('../ports/target-dispatcher.js').HarnessTargetInput<Target>; invocation: HarnessRootTargetDispatchInvocation }>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>> {
			const route = assertTarget(request.target)
			return openRoute(route, request.input, request.invocation, undefined, 'root') as Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
		},
		async open<Target extends AnyHarnessTargetContract>(request: HarnessTargetDispatchRequest<Target>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>> {
			const route = assertTarget(request.target)
			return openRoute(route, request.input, request.invocation) as Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
		},
		async openPersisted(request: PersistedHarnessTargetDispatchRequest): Promise<HarnessTargetDispatchStream<JsonValue>> {
			assertRouteReceipt(request.route)
			const route = routesByReceipt.get(canonicalJson(request.route))
			if (route === undefined) throw new HarnessTargetRouteReceiptMismatchError({
				reason: 'route_receipt_mismatch', target_kind: request.route.target.kind, target_id: request.route.target.id,
			})
			validateInvocation(request.invocation, 'nested')
			if (request.resume.runId !== request.invocation.invocationId) {
				throw new HarnessConfigError('Persisted target resume is invalid.', {
					reason: 'invalid_target_dispatch', path: 'targetDispatcher.resume.runId',
				})
			}
			if (!isJsonValue(request.wireInput)) throw new ValidationError('Target input validation failed.', {
				where: route.definition.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_target_input' },
			})
			const invocation = normalizeInvocation(request.invocation, route.configuredMaxDepth)
			return withAbortSignal(request.invocation.signal, route.definition.kind, 'Target dispatch was cancelled.', () => route.execute(Object.freeze({
				delivery: 'resume' as const, definition: route.definition, wireInput: request.wireInput,
				resume: request.resume, invocation,
			})))
		},
	})
}

function eraseLocalBinding<D extends AnyDefinition>(binding: LocalTargetBinding<D>, configuredMaxDepth: number, receipt: HarnessTargetRouteReceiptV1): LocalRoute {
	const contract = binding.definition.contract
	return Object.freeze({
		definition: binding.definition,
		contract,
		configuredMaxDepth,
		receipt,
		async execute(request: LocalTargetExecutionRequest<AnyDefinition>) {
			const opened = await binding.execute(request as LocalTargetExecutionRequest<D>)
			return opened as HarnessTargetDispatchStream<JsonValue>
		},
	})
}

function normalizeInvocation(invocationValue: HarnessTargetDispatchInvocation, configuredMaxDepth: number): HarnessTargetDispatchInvocation {
	const identityValue = normalizeHarnessIdentity(invocationValue.identity)
	const trace = invocationValue.trace === undefined ? undefined : normalizeHarnessTraceContext(invocationValue.trace)
	return Object.freeze({ ...invocationValue,
		remainingDepth: Math.min(invocationValue.remainingDepth, configuredMaxDepth),
		...(identityValue === undefined ? {} : { identity: identityValue }),
		...(trace === undefined ? {} : { trace }),
	})
}

function createRouteReceipt(kind: 'agent' | 'workflow', id: string, revision: string): HarnessTargetRouteReceiptV1 {
	const bindingDigest = `sha256:${createHash('sha256').update(canonicalJson([
		'harness.target-route-binding.v1', 'harness.local', revision, kind, id,
	])).digest('hex')}`
	return Object.freeze({
		schemaVersion: 1 as const,
		kind: 'harness_target_route' as const,
		target: Object.freeze({ kind, id }),
		bindingDigest,
	})
}

function assertRouteReceipt(value: unknown): asserts value is HarnessTargetRouteReceiptV1 {
	if (!isJsonValue(value) || !isPlainRecord(value) || !hasExactKeys(value, ['schemaVersion', 'kind', 'target', 'bindingDigest'])
		|| value['schemaVersion'] !== 1 || value['kind'] !== 'harness_target_route'
		|| !isPlainRecord(value['target']) || !hasExactKeys(value['target'], ['kind', 'id'])
		|| (value['target']['kind'] !== 'agent' && value['target']['kind'] !== 'workflow')
		|| typeof value['target']['id'] !== 'string' || value['target']['id'].length === 0
		|| typeof value['bindingDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value['bindingDigest'])) {
		throw new HarnessConfigError('Persisted target route receipt is invalid.', {
			reason: 'invalid_target_dispatch', path: 'targetDispatcher.route',
		})
	}
}

function validRouteRevision(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !/\p{Cc}/u.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Reflect.ownKeys(value)
	return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

function validateInvocation(invocation: import('../ports/target-dispatcher.js').HarnessTargetDispatchInvocation, ancestry: 'root' | 'nested'): void {
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
	const hasAgent = invocation.parentAgentId !== undefined
	const hasWorkflow = invocation.parentWorkflowId !== undefined
	if (ancestry === 'nested' ? hasAgent === hasWorkflow : hasAgent || hasWorkflow) {
		throw new HarnessConfigError('Target dispatch invocation is invalid.', {
			reason: 'invalid_target_dispatch', path: 'targetDispatcher.invocation.parentTarget',
		})
	}
	if ((hasAgent && (typeof invocation.parentAgentId !== 'string' || invocation.parentAgentId.length === 0))
		|| (hasWorkflow && (typeof invocation.parentWorkflowId !== 'string' || invocation.parentWorkflowId.length === 0))
		|| (ancestry === 'root' && invocation.depth !== 0) || (ancestry === 'nested' && invocation.depth < 1)) {
		throw new HarnessConfigError('Target dispatch invocation is invalid.', {
			reason: 'invalid_target_dispatch', path: 'targetDispatcher.invocation.parentTarget',
		})
	}
}

function foreignDefinition(): HarnessConfigError {
	return new HarnessConfigError('Target contract is not registered with this dispatcher.', {
		reason: 'foreign_definition', path: 'targetDispatcher.target',
	})
}
