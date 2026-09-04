/** @internal Encodes strict JSON with deterministic Unicode code-point key order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite.')
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		const allowedKeys = new Set<PropertyKey>(['length', ...Array.from({ length: value.length }, (_unused, index) => String(index))])
		if (Reflect.ownKeys(value).some(key => !allowedKeys.has(key)) || Array.from({ length: value.length }, (_unused, index) => index).some(index => !(index in value))) {
			throw new TypeError('Canonical JSON arrays must be dense.')
		}
		return `[${value.map(canonicalJson).join(',')}]`
	}
	if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
		throw new TypeError('Canonical JSON objects must be plain records.')
	}
	if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON objects must not contain symbol keys.')
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => codePointCompare(left, right))
	return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
}

function codePointCompare(left: string, right: string): number {
	const leftPoints = Array.from(left, character => character.codePointAt(0)!)
	const rightPoints = Array.from(right, character => character.codePointAt(0)!)
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
	}
	return leftPoints.length - rightPoints.length
}
