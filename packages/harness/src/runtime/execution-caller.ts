import type { HarnessExecutionCaller } from '../definitions/types.js'

/** @internal Validates, copies, and freezes the sole runtime caller projection. */
export function projectHarnessExecutionCaller(value: unknown): HarnessExecutionCaller {
	if (!plain(value)) throw new TypeError('Harness execution caller is invalid.')
	if (value['kind'] === 'agent') {
		if (!nonempty(value['agentId']) || value['workflowId'] !== undefined && !nonempty(value['workflowId'])
			|| !exactKeys(value, value['workflowId'] === undefined ? ['kind', 'agentId'] : ['kind', 'agentId', 'workflowId'])) {
			throw new TypeError('Harness execution caller is invalid.')
		}
		return Object.freeze({ kind: 'agent', agentId: value['agentId'],
			...(value['workflowId'] === undefined ? {} : { workflowId: value['workflowId'] }) })
	}
	if (value['kind'] === 'workflow') {
		if (!nonempty(value['workflowId']) || !exactKeys(value, ['kind', 'workflowId'])) {
			throw new TypeError('Harness execution caller is invalid.')
		}
		return Object.freeze({ kind: 'workflow', workflowId: value['workflowId'] })
	}
	throw new TypeError('Harness execution caller is invalid.')
}

function plain(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function nonempty(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort()
	return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key)
}
