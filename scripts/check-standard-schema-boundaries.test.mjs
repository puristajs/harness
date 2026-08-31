import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findForbiddenStandardSchemaPatterns } from './check-standard-schema-boundaries.mjs'

test('rejects each retired public-boundary implementation pattern', () => {
  for (const [source, rule] of [
    ['type Value<S extends z.ZodTypeAny> = S', 'legacy-zod-generic'],
    ['type Default = z.ZodString', 'legacy-zod-generic'],
    ['type T = z.input<typeof inputSchema>', 'legacy-zod-infer'],
    ['type T = z.output<typeof outputSchema>', 'legacy-zod-infer'],
    ['return inputSchema.parse(candidate)', 'direct-user-schema-parser'],
    ['return z.toJSONSchema(schema)', 'runtime-zod-json-schema'],
    ['const json = schema as JsonValue', 'validator-json-cast'],
    ['const legacySchema = schema', 'compatibility-path'],
    ['// TODO: Standard Schema cross-vendor fixture', 'placeholder-conformance'],
    ["it.skip('cross-vendor Standard Schema conformance', () => {})", 'skipped-conformance']
  ]) assert.ok(findForbiddenStandardSchemaPatterns(source).some((finding) => finding.rule === rule), rule)
})

test('allows the shared structural Standard Schema path', () => {
  const source = "return validateSchema(valueSchema, candidate, { where: 'agent_input', message: 'Agent input validation failed.' })"
  assert.deepEqual(findForbiddenStandardSchemaPatterns(source), [])
})
