import { validateContextProjection, type ContextProjectionPolicy } from '../context-projection.js'
import { HarnessConfigError } from '../errors/index.js'
import { validateSessionHistoryRetention, type SessionHistoryRetentionPolicy } from '../sessions/history-retention.js'

/** Closed definition-time defaults shared by every Harness execution stage. */
export interface HarnessExecutionDefaults {
	readonly maxSteps?: number
	readonly maxToolCalls?: number
	readonly maxSubagentCalls?: number
	readonly maxParallelSubagents?: number
	readonly maxDepth?: number
	readonly runTimeoutMs?: number
	readonly modelTimeoutMs?: number
	readonly toolTimeoutMs?: number
	readonly skillTimeoutMs?: number
	readonly decisionTimeoutMs?: number
	readonly maxParallelToolCalls?: number
	readonly historyWindow?: number
	readonly contextProjection?: ContextProjectionPolicy
	readonly historyRetention?: SessionHistoryRetentionPolicy
}

/** Fully resolved immutable defaults stored on a Harness definition. */
export interface ResolvedHarnessExecutionDefaults {
	readonly maxSteps: number
	readonly maxToolCalls: number
	readonly maxSubagentCalls: number
	readonly maxParallelSubagents: number
	readonly maxDepth: number
	readonly runTimeoutMs: number
	readonly modelTimeoutMs: number
	readonly toolTimeoutMs: number
	readonly skillTimeoutMs: number
	readonly decisionTimeoutMs: number
	readonly maxParallelToolCalls: number
	readonly historyWindow?: number
	readonly contextProjection?: ContextProjectionPolicy
	readonly historyRetention?: SessionHistoryRetentionPolicy
}

const fields = Object.freeze([
	'maxSteps', 'maxToolCalls', 'maxSubagentCalls', 'maxParallelSubagents', 'maxDepth',
	'runTimeoutMs', 'modelTimeoutMs', 'toolTimeoutMs', 'skillTimeoutMs', 'decisionTimeoutMs',
	'maxParallelToolCalls', 'historyWindow', 'contextProjection', 'historyRetention',
] as const)

const constants = Object.freeze({
	maxSteps: 16,
	maxToolCalls: 32,
	maxSubagentCalls: 32,
	maxParallelSubagents: 8,
	maxDepth: 1,
	runTimeoutMs: 600_000,
	modelTimeoutMs: 300_000,
	toolTimeoutMs: 120_000,
	skillTimeoutMs: 60_000,
	decisionTimeoutMs: 10_000,
	maxParallelToolCalls: 8,
})

/** Validates and resolves the single definition-time execution-default snapshot. */
export function resolveHarnessExecutionDefaults(value?: HarnessExecutionDefaults): ResolvedHarnessExecutionDefaults {
	if (value !== undefined && !isPlainRecord(value)) fail('defaults')
	const input: Record<string, unknown> = value ?? {}
	const ownKeys = Reflect.ownKeys(input)
	if (ownKeys.some(key => typeof key !== 'string')) fail('defaults')
	const unknown = (ownKeys as string[]).sort(codePointCompare).find(key => !(fields as readonly string[]).includes(key))
	if (unknown !== undefined) fail(`defaults.${unknown}`)
	for (const field of fields.slice(0, 11)) {
		const candidate = input[field]
		if (candidate === undefined) continue
		const permitsZero = field === 'runTimeoutMs'
		if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || (permitsZero ? candidate < 0 : candidate <= 0)) fail(`defaults.${field}`)
	}
	const historyWindow = input['historyWindow']
	if (historyWindow !== undefined && (typeof historyWindow !== 'number' || !Number.isSafeInteger(historyWindow) || historyWindow < 0)) {
		fail('defaults.historyWindow')
	}
	const contextProjectionValue = input['contextProjection']
	const retentionValue = input['historyRetention']
	const contextProjection = contextProjectionValue === undefined ? undefined : snapshotProjection(contextProjectionValue)
	const historyRetention = retentionValue === undefined ? undefined : snapshotRetention(retentionValue)
	return Object.freeze({
		...constants,
		...Object.fromEntries(fields.slice(0, 11).flatMap(field => input[field] === undefined ? [] : [[field, input[field]]])),
		...(historyWindow === undefined ? {} : { historyWindow }),
		...(contextProjection === undefined ? {} : { contextProjection }),
		...(historyRetention === undefined ? {} : { historyRetention }),
	}) as ResolvedHarnessExecutionDefaults
}

function snapshotProjection(value: unknown): ContextProjectionPolicy {
	if (!isPlainRecord(value)) fail('defaults.contextProjection')
	const projectionKeys = Reflect.ownKeys(value)
	const invalidProjectionKey = projectionKeys.find(key => typeof key !== 'string' || key !== 'toolResultPruner')
	if (invalidProjectionKey !== undefined) fail(typeof invalidProjectionKey === 'string' ? `defaults.contextProjection.${invalidProjectionKey}` : 'defaults.contextProjection')
	const pruner = value['toolResultPruner']
	if (!isPlainRecord(pruner)) fail('defaults.contextProjection.toolResultPruner')
	const invalidPrunerKey = Reflect.ownKeys(pruner).find(key => typeof key !== 'string' || !['maxBytes', 'headBytes', 'tailBytes', 'marker'].includes(key))
	if (invalidPrunerKey !== undefined) fail(typeof invalidPrunerKey === 'string' ? `defaults.contextProjection.toolResultPruner.${invalidPrunerKey}` : 'defaults.contextProjection.toolResultPruner')
	if (!validateContextProjection(value as ContextProjectionPolicy)) fail('defaults.contextProjection')
	return Object.freeze({ toolResultPruner: Object.freeze({
		maxBytes: pruner['maxBytes'] as number,
		headBytes: pruner['headBytes'] as number,
		tailBytes: pruner['tailBytes'] as number,
		...(pruner['marker'] === undefined ? {} : { marker: pruner['marker'] as string }),
	}) })
}

function snapshotRetention(value: unknown): SessionHistoryRetentionPolicy {
	if (!isPlainRecord(value)) fail('defaults.historyRetention')
	const invalidKey = Reflect.ownKeys(value).find(key => typeof key !== 'string' || !['maxTurns', 'maxBytes'].includes(key))
	if (invalidKey !== undefined) fail(typeof invalidKey === 'string' ? `defaults.historyRetention.${invalidKey}` : 'defaults.historyRetention')
	if (!validateSessionHistoryRetention(value as SessionHistoryRetentionPolicy)) fail('defaults.historyRetention')
	return Object.freeze({
		...(value['maxTurns'] === undefined ? {} : { maxTurns: value['maxTurns'] as number }),
		...(value['maxBytes'] === undefined ? {} : { maxBytes: value['maxBytes'] as number }),
	})
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function fail(path: string): never {
	throw new HarnessConfigError('Harness execution defaults are invalid.', {
		reason: 'invalid_execution_defaults', path: `harness.${path}`,
	})
}

function codePointCompare(left: string, right: string): number {
	const leftPoints = Array.from(left, character => character.codePointAt(0)!)
	const rightPoints = Array.from(right, character => character.codePointAt(0)!)
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
	}
	return leftPoints.length - rightPoints.length
}
