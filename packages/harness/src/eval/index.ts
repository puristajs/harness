import { ValidationError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'

export type DeterministicScorerDefinition =
	| { type: 'regex'; path: string; pattern: string; flags?: 'i' | 'm' | 'im' }
	| { type: 'json-schema'; schema: JsonValue }
	| { type: 'contains'; path: string; value: string; caseInsensitive?: boolean }
	| { type: 'attribute-equality'; leftPath: string; rightPath: string }

export interface ScorerTarget {
	input: unknown
	output: unknown
	expected?: unknown
	context?: unknown[]
}

export interface ScorerResult {
	score: number
	passed: boolean
	evidence?: JsonValue
}

export interface PromptCandidate<I = unknown> {
	id: string
	prompt: string
	metadata?: Record<string, JsonValue>
}

export interface EvaluationItem<I = unknown> {
	id: string
	input: I
	expected?: unknown
	context?: unknown[]
}

export interface CandidateScore {
	candidateId: string
	meanScore: number
	passRate: number
	itemCount: number
	scorerCount: number
}

export interface EvaluatePromptCandidatesInput<I = unknown> {
	candidates: PromptCandidate<I>[]
	items: EvaluationItem<I>[]
	scorer: (target: ScorerTarget, signal: AbortSignal) => Promise<ScorerResult>
	runCandidate: (candidate: PromptCandidate<I>, item: EvaluationItem<I>, signal: AbortSignal) => Promise<unknown>
	signal: AbortSignal
}

type PointerResult = { found: true; value: unknown } | { found: false }

export function evaluateDeterministicScorer(definition: DeterministicScorerDefinition, target: ScorerTarget): ScorerResult {
	switch (definition.type) {
		case 'regex': {
			const selected = readPointer(target.output, definition.path)
			if (!selected.found) return missingPointer(definition.path)
			return binary(new RegExp(definition.pattern, definition.flags ?? '').test(String(selected.value)))
		}
		case 'contains': {
			const selected = readPointer(target.output, definition.path)
			if (!selected.found) return missingPointer(definition.path)
			const haystack = String(selected.value)
			const needle = definition.value
			return binary(definition.caseInsensitive
				? haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
				: haystack.includes(needle))
		}
		case 'attribute-equality': {
			const left = readPointer(target.output, definition.leftPath)
			if (!left.found) return missingPointer(definition.leftPath)
			const right = readPointer(target.output, definition.rightPath)
			if (!right.found) return missingPointer(definition.rightPath)
			return deepEqual(left.value, right.value)
				? binary(true)
				: { score: 0, passed: false, evidence: { left: toJsonValue(left.value), right: toJsonValue(right.value) } }
		}
		case 'json-schema': {
			const result = validateJsonSchema(definition.schema, target.output)
			return result.passed
				? binary(true)
				: { score: 0, passed: false, evidence: { reason: 'schema_validation_failed', issues: result.issues } }
		}
	}
}

export async function evaluatePromptCandidates<I = unknown>(input: EvaluatePromptCandidatesInput<I>): Promise<CandidateScore[]> {
	if (input.candidates.length === 0) {
		throw new ValidationError('At least one prompt candidate is required.', { where: 'eval_input', issues: { candidates: 'empty' } })
	}
	if (input.items.length === 0) {
		throw new ValidationError('At least one evaluation item is required.', { where: 'eval_input', issues: { items: 'empty' } })
	}

	const scores: CandidateScore[] = []
	for (const candidate of input.candidates) {
		input.signal.throwIfAborted()
		let total = 0
		let passed = 0
		let scorerCount = 0
		for (const item of input.items) {
			input.signal.throwIfAborted()
			const output = await input.runCandidate(candidate, item, input.signal)
			const target: ScorerTarget = {
				input: item.input,
				output
			}
			if (item.expected !== undefined) target.expected = item.expected
			if (item.context !== undefined) target.context = item.context
			const result = await input.scorer(target, input.signal)
			total += result.score
			passed += result.passed ? 1 : 0
			scorerCount += 1
		}
		scores.push({
			candidateId: candidate.id,
			meanScore: total / scorerCount,
			passRate: passed / scorerCount,
			itemCount: input.items.length,
			scorerCount
		})
	}

	return scores.sort((a, b) => {
		if (a.meanScore !== b.meanScore) return b.meanScore - a.meanScore
		if (a.passRate !== b.passRate) return b.passRate - a.passRate
		return a.candidateId.localeCompare(b.candidateId)
	})
}

function binary(passed: boolean): ScorerResult {
	return { score: passed ? 1 : 0, passed }
}

function missingPointer(path: string): ScorerResult {
	return { score: 0, passed: false, evidence: { reason: 'missing_pointer', path } }
}

function readPointer(value: unknown, pointer: string): PointerResult {
	if (pointer === '') return { found: true, value }
	if (!pointer.startsWith('/')) return { found: false }
	let current: unknown = value
	for (const rawPart of pointer.slice(1).split('/')) {
		const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
		if (Array.isArray(current)) {
			const index = Number(part)
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false }
			current = current[index]
			continue
		}
		if (!isRecord(current) || !(part in current)) return { found: false }
		current = current[part]
	}
	return { found: true, value: current }
}

function validateJsonSchema(schema: JsonValue, value: unknown): { passed: boolean; issues: JsonValue[] } {
	const issues: JsonValue[] = []
	validateSchemaAt(schema, value, '', issues)
	return { passed: issues.length === 0, issues }
}

function validateSchemaAt(schema: JsonValue, value: unknown, path: string, issues: JsonValue[]): void {
	if (!isRecord(schema)) return
	if ('const' in schema && !deepEqual(value, schema['const'])) {
		issues.push({ path, reason: 'const', expected: toJsonValue(schema['const']), actual: toJsonValue(value) })
		return
	}
	if (Array.isArray(schema['enum']) && !schema['enum'].some((entry) => deepEqual(entry, value))) {
		issues.push({ path, reason: 'enum', actual: toJsonValue(value) })
		return
	}
	const type = typeof schema['type'] === 'string' ? schema['type'] : undefined
	if (type && !matchesType(value, type)) {
		issues.push({ path, reason: 'type', expected: type, actual: typeof value })
		return
	}
	if (type === 'object' || schema['properties']) {
		if (!isRecord(value)) {
			issues.push({ path, reason: 'type', expected: 'object', actual: typeof value })
			return
		}
		const required = Array.isArray(schema['required']) ? schema['required'].filter((entry): entry is string => typeof entry === 'string') : []
		for (const key of required) {
			if (!(key in value)) issues.push({ path: `${path}/${key}`, reason: 'required' })
		}
		const properties = isRecord(schema['properties']) ? schema['properties'] : {}
		for (const [key, childSchema] of Object.entries(properties)) {
			if (key in value) validateSchemaAt(childSchema as JsonValue, value[key], `${path}/${key}`, issues)
		}
		if (schema['additionalProperties'] === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) issues.push({ path: `${path}/${key}`, reason: 'additional_properties' })
			}
		}
	}
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'object': return isRecord(value)
		case 'array': return Array.isArray(value)
		case 'string': return typeof value === 'string'
		case 'number': return typeof value === 'number' && Number.isFinite(value)
		case 'integer': return Number.isInteger(value)
		case 'boolean': return typeof value === 'boolean'
		case 'null': return value === null
		default: return true
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
	if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry))
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]))
	return String(value)
}
