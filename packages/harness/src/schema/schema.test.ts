import { describe, expect, it } from 'vitest'
import { serializeError, type ModelSchema, type Schema } from '../index.js'
import { projectModelSchema } from './json-schema.js'
import { validateSchema } from './validation.js'

function schema(result: unknown): Schema {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => result as never
    }
  }
}

describe('Standard Schema runtime boundary', () => {
  it('awaits one validation and returns only the validated JSON transform', async () => {
    let calls = 0
    const asyncSchema: Schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async () => {
          calls += 1
          return { value: { transformed: true } }
        }
      }
    }

    await expect(validateSchema(asyncSchema, { ignored: true }, {
      where: 'agent_input',
      message: 'Agent input validation failed.'
    })).resolves.toEqual({ transformed: true })
    expect(calls).toBe(1)
  })

  it('redacts returned issues, thrown validators, and malformed or non-JSON successful values', async () => {
    const issues = await validateSchema(schema({ issues: Array.from({ length: 101 }, () => ({ message: 'secret', path: ['secret'] })) }), null, {
      where: 'tool_input', message: 'Tool input validation failed.'
    }).catch(serializeError)
    expect(issues).toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'tool_input', issues: { count: 100, truncated: true } } })
    expect(JSON.stringify(issues)).not.toContain('secret')

    const throwing: Schema = {
      '~standard': { version: 1, vendor: 'test', validate: () => { throw new Error('private candidate') } }
    }
    const failure = await validateSchema(throwing, null, {
      where: 'workflow_input', message: 'Workflow input validation failed.'
    }).catch(serializeError)
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', meta: { reason: 'schema_validation_execution_failed', where: 'workflow_input' } })
    expect(JSON.stringify(failure)).not.toContain('private candidate')

    const nonJson = await validateSchema(schema({ value: new Date() }), null, {
      where: 'workflow_output', message: 'Workflow output validation failed.'
    }).catch(serializeError)
    expect(nonJson).toMatchObject({ code: 'INTERNAL_ERROR', meta: { reason: 'schema_validation_non_json', where: 'workflow_output' } })

    for (const malformed of [null, 'not a validation result']) {
      const result = await validateSchema(schema(malformed), null, {
        where: 'workflow_output', message: 'Workflow output validation failed.'
      }).catch(serializeError)
      expect(result).toMatchObject({ code: 'INTERNAL_ERROR', meta: { reason: 'schema_validation_non_json', where: 'workflow_output' } })
    }
  })

  it('projects input JSON Schema once into an immutable owned value', () => {
    let calls = 0
    const source = { type: 'object', properties: { ticket: { type: 'string' } } }
    const modelSchema: ModelSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: {
          input: (options) => {
            calls += 1
            expect(options).toEqual({ target: 'draft-2020-12' })
            return source
          }
        }
      }
    }
    const projected = projectModelSchema(modelSchema, 'tool_input', 'lookup')
    expect(calls).toBe(1)
    expect(projected).toEqual(source)
    expect(projected).not.toBe(source)
    expect(Object.isFrozen(projected)).toBe(true)
    expect(Object.isFrozen((projected as Record<string, unknown>)['properties'])).toBe(true)
  })

  it.each([
    ['schema_json_projection_missing', schema({ value: {} }) as ModelSchema],
    ['schema_json_projection_failed', {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: { input: () => { throw new Error('private') } }
      }
    } as ModelSchema],
    ['schema_json_projection_invalid', {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: { input: () => new Date() }
      }
    } as ModelSchema]
  ] as const)('returns a closed %s projection error', (reason, invalid) => {
    expect(() => projectModelSchema(invalid, 'agent_output', 'agent')).toThrow(expect.objectContaining({
      code: 'HARNESS_CONFIG_ERROR',
      meta: { reason, schemaBoundary: 'agent_output', id: 'agent', schemaTarget: 'draft-2020-12' }
    }))
  })

  it('rejects unsafe projection access and every non-JSON projected value shape', () => {
    const inaccessibleJsonSchema: ModelSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        get jsonSchema() { throw new Error('private projection') }
      }
    }
    const inaccessibleInput: ModelSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: {
          get input() { throw new Error('private projection') }
        }
      }
    }
    const invalidProjections: readonly unknown[] = [
      undefined,
      Number.POSITIVE_INFINITY,
      [undefined],
      Object.assign([], { extra: true }),
      Object.assign({}, { [Symbol('brand')]: true }),
      Object.create({ inherited: true }),
      Object.defineProperty({}, 'computed', { enumerable: true, get: () => 'value' })
    ]

    for (const invalid of [inaccessibleJsonSchema, inaccessibleInput]) {
      expect(() => projectModelSchema(invalid, 'tool_input', 'lookup')).toThrow(expect.objectContaining({
        code: 'HARNESS_CONFIG_ERROR',
        meta: expect.objectContaining({ reason: 'schema_json_projection_failed' })
      }))
    }
    for (const projection of invalidProjections) {
      const modelSchema: ModelSchema = {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({ value: {} }),
          jsonSchema: { input: () => projection as never }
        }
      }
      expect(() => projectModelSchema(modelSchema, 'tool_input', 'lookup')).toThrow(expect.objectContaining({
        code: 'HARNESS_CONFIG_ERROR',
        meta: expect.objectContaining({ reason: 'schema_json_projection_invalid' })
      }))
    }

    const throwingProxy = new Proxy({}, { ownKeys: () => { throw new Error('private projection') } })
    const throwingProjection: ModelSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: { input: () => throwingProxy }
      }
    }
    expect(() => projectModelSchema(throwingProjection, 'tool_input', 'lookup')).toThrow(expect.objectContaining({
      code: 'HARNESS_CONFIG_ERROR',
      meta: expect.objectContaining({ reason: 'schema_json_projection_invalid' })
    }))
  })

  it('accepts null-prototype JSON objects while dropping non-enumerable schema metadata', () => {
    const projection = Object.assign(Object.create(null), { type: 'object', properties: Object.assign(Object.create(null), { value: { type: 'string' } }) })
    Object.defineProperty(projection, '~standard', { enumerable: false, value: { vendor: 'test' } })
    const modelSchema: ModelSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: {} }),
        jsonSchema: { input: () => projection }
      }
    }

    expect(projectModelSchema(modelSchema, 'tool_input', 'lookup')).toEqual({
      type: 'object', properties: { value: { type: 'string' } }
    })
  })

  it('treats malformed Standard Schema validation results as closed non-JSON failures', async () => {
    const malformed = await validateSchema(schema({ issues: 'not-an-array' }), null, {
      where: 'agent_output', message: 'Agent output validation failed.'
    }).catch(serializeError)

    expect(malformed).toMatchObject({
      code: 'INTERNAL_ERROR', meta: { reason: 'schema_validation_non_json', where: 'agent_output' }
    })
  })
})
