import { describe, expect, it, vi } from 'vitest'
import { isJsonValue } from '../src/models/json.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'

describe('canonicalJson', () => {
	it('orders object keys by Unicode code point and preserves arrays', () => {
		expect(canonicalJson({ z: 1, a: ['first', { b: true, a: null }] })).toBe('{"a":["first",{"a":null,"b":true}],"z":1}')
	})

	it('rejects accessors without invoking them', () => {
		const getter = vi.fn(() => 'secret')
		const value = Object.defineProperty({}, 'secret', { enumerable: true, get: getter })
		expect(() => canonicalJson(value)).toThrow(TypeError)
		expect(getter).not.toHaveBeenCalled()
	})

	it.each([
		['hidden object property', Object.defineProperty({}, 'hidden', { enumerable: false, value: true })],
		['symbol object property', { [Symbol('hidden')]: true }],
		['sparse array', [, 'value']],
		['hidden array property', Object.defineProperty(['value'], 'hidden', { enumerable: false, value: true })],
		['custom object prototype', Object.create({ inherited: true })],
		['custom array prototype', Object.setPrototypeOf(['value'], Object.create(Array.prototype))],
	])('rejects %s', (_name, value) => {
		expect(() => canonicalJson(value)).toThrow(TypeError)
		expect(isJsonValue(value)).toBe(false)
	})

	it('accepts null-prototype records with own enumerable data', () => {
		const value = Object.assign(Object.create(null) as Record<string, unknown>, { safe: true })
		expect(canonicalJson(value)).toBe('{"safe":true}')
	})
})
