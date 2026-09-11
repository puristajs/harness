import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkStandardSchemaBoundaries, findForbiddenStandardSchemaPatterns, publicBoundaryOwners } from './check-standard-schema-boundaries.mjs'

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

test('checks boundary owners from a standalone repository checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-standard-schema-'))
  try {
    for (const owner of publicBoundaryOwners) {
      const file = join(root, owner.path.replace(/^ai-harness\//, ''))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, 'export {}\n')
    }

    assert.deepEqual(await checkStandardSchemaBoundaries(root), [])

    const owner = publicBoundaryOwners[0]
    const file = join(root, owner.path.replace(/^ai-harness\//, ''))
    await writeFile(file, 'type Value<S extends z.ZodTypeAny> = S\n')
    assert.deepEqual(await checkStandardSchemaBoundaries(root), [
      { path: owner.path, line: 1, rule: 'legacy-zod-generic', match: 'z.ZodTypeAny' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
