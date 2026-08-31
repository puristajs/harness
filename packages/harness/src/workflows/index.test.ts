import { describe, expect, it } from 'vitest'
import { OperationCancelledError, ValidationError } from '../errors/index.js'
import type { Schema } from '../schema/index.js'
import { runWorkflow } from './index.js'

function schema(result: unknown): Schema {
  return {
    '~standard': { version: 1, vendor: 'test', validate: () => result as never }
  }
}

function context(signal = new AbortController().signal) {
  return { signal } as never
}

describe('runWorkflow Standard Schema boundary', () => {
  it('validates transformed input and output through async Standard Schema validators', async () => {
    const input: Schema = {
      '~standard': { version: 1, vendor: 'test', validate: async () => ({ value: { normalized: 'input' } }) }
    }
    const output: Schema = {
      '~standard': { version: 1, vendor: 'test', validate: async (value) => ({ value: { result: (value as { result: string }).result.toUpperCase() } }) }
    }

    await expect(runWorkflow({
      workflowId: 'transform',
      input: 'ignored',
      workflow: { input, output, handler: async (ctx: { input: { normalized: string } }) => ({ result: ctx.input.normalized }) } as never,
      ctx: context()
    })).resolves.toEqual({ result: 'INPUT' })
  })

  it('uses internal string schemas when workflow schemas are omitted', async () => {
    await expect(runWorkflow({
      workflowId: 'default-schemas',
      input: 'accepted',
      workflow: { handler: async (ctx: { input: string }) => ctx.input.toUpperCase() } as never,
      ctx: context()
    })).resolves.toBe('ACCEPTED')

    await expect(runWorkflow({
      workflowId: 'default-input-rejects-non-string',
      input: { accepted: true },
      workflow: { handler: async () => 'unreachable' } as never,
      ctx: context()
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_input' } })

    await expect(runWorkflow({
      workflowId: 'default-output-rejects-non-string',
      input: 'accepted',
      workflow: { handler: async () => ({ accepted: true }) } as never,
      ctx: context()
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
  })

  it('maps invalid input and output to their public validation boundaries', async () => {
    await expect(runWorkflow({
      workflowId: 'invalid-input',
      input: null,
      workflow: { input: schema({ issues: [{ message: 'private' }] }), handler: async () => 'unreachable' } as never,
      ctx: context()
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_input' } })

    await expect(runWorkflow({
      workflowId: 'invalid-output',
      input: 'candidate',
      workflow: { output: schema({ issues: [{ message: 'private' }] }), handler: async () => 'candidate' } as never,
      ctx: context()
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
  })

  it('preserves handler failures and rejects cancellation before and after work', async () => {
    const failed = new Error('handler failed')
    await expect(runWorkflow({
      workflowId: 'handler-error', input: 'candidate',
      workflow: { handler: async () => { throw failed } } as never,
      ctx: context()
    })).rejects.toBe(failed)

    const before = new AbortController()
    before.abort()
    await expect(runWorkflow({
      workflowId: 'cancelled-before', input: 'candidate',
      workflow: { handler: async () => 'unreachable' } as never,
      ctx: context(before.signal)
    })).rejects.toBeInstanceOf(OperationCancelledError)

    const after = new AbortController()
    await expect(runWorkflow({
      workflowId: 'cancelled-after', input: 'candidate',
      workflow: { handler: async () => { after.abort(); return 'late' } } as never,
      ctx: context(after.signal)
    })).rejects.toBeInstanceOf(OperationCancelledError)
  })
})
