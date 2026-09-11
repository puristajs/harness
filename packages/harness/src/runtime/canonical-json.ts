/** @internal Encodes strict JSON with deterministic Unicode code-point key order. */
export function canonicalJson(value: unknown): string {
	return encodeCanonicalJson(value, new Set<object>())
}

function encodeCanonicalJson(value: unknown, ancestors: Set<object>): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite.')
		return JSON.stringify(value)
	}
	if (typeof value !== 'object') throw new TypeError('Canonical JSON values must contain only JSON data.')
	if (ancestors.has(value)) throw new TypeError('Canonical JSON values must not contain cycles.')

	ancestors.add(value)
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value)
		const keys = Reflect.ownKeys(descriptors)
		if (keys.some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON values must not contain symbol keys.')

		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Canonical JSON arrays must use the standard prototype.')
			const length = descriptors['length']
			if (!length || !('value' in length) || length.value !== value.length) throw new TypeError('Canonical JSON arrays must have a data length.')
			const items: string[] = []
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)]
				if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON arrays must be dense enumerable data.')
				items.push(encodeCanonicalJson(descriptor.value, ancestors))
			}
			if (keys.length !== value.length + 1) throw new TypeError('Canonical JSON arrays must contain only indexes and length.')
			return `[${items.join(',')}]`
		}

		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON objects must be plain records.')
		const stringKeys = keys as string[]
		for (const key of stringKeys) {
			const descriptor = descriptors[key]
			if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON objects must contain only enumerable data properties.')
		}
		stringKeys.sort(codePointCompare)
		return `{${stringKeys.map(key => `${JSON.stringify(key)}:${encodeCanonicalJson((descriptors[key] as PropertyDescriptor & { value: unknown }).value, ancestors)}`).join(',')}}`
	} finally {
		ancestors.delete(value)
	}
}

function codePointCompare(left: string, right: string): number {
	const leftPoints = Array.from(left, character => character.codePointAt(0)!)
	const rightPoints = Array.from(right, character => character.codePointAt(0)!)
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
	}
	return leftPoints.length - rightPoints.length
}
