import { OperationCancelledError } from '../errors/index.js'
import type { BuilderState, InvokeOptions, WorkflowContext, WorkflowDefinition } from '../harness/defineHarness.js'
import { withAbortSignal } from '../runtime/abort.js'
import { validateSchema } from '../schema/validation.js'
import type { JsonValue } from '../models/json.js'
import type { Schema } from '../schema/index.js'

export async function runWorkflow<S extends BuilderState>(args: {
  workflowId: string
  workflow: WorkflowDefinition<S, any, any>
  input: unknown
  ctx: Omit<WorkflowContext<S, unknown, unknown>, 'input'>
  opts?: InvokeOptions
}): Promise<unknown> {
  if (args.ctx['signal'].aborted)
    throw new OperationCancelledError('Workflow execution was cancelled.', { scope: 'workflow' })
  const inputSchema = args.workflow.input ?? z.string()
  const parsed = await validateWorkflowSchema(inputSchema, args.input, 'workflow_input', args.ctx['signal'])
  // The handler error (including errors bubbling from agent/model/tool calls) is
  // intentionally preserved by identity so failure terminalization never masks
  // the original failure. See spec 10 "Errors".
  const output = await withAbortSignal(args.ctx['signal'], 'workflow', 'Workflow execution was cancelled.', () =>
    args.workflow.handler({ ...(args.ctx as WorkflowContext<S, unknown, unknown>), input: parsed }),
  )
  if (args.ctx['signal'].aborted)
    throw new OperationCancelledError('Workflow execution was cancelled.', { scope: 'workflow' })
  const outputSchema = args.workflow.output ?? z.string()
  return validateWorkflowSchema(outputSchema, output, 'workflow_output', args.ctx['signal'])
}

function validateWorkflowSchema(
  schema: Schema<any, any>,
  candidate: unknown,
  where: 'workflow_input' | 'workflow_output',
  signal: AbortSignal,
): Promise<JsonValue> {
  return validateSchema(schema, candidate, {
    where,
    message: where === 'workflow_input' ? 'Workflow input validation failed.' : 'Workflow output validation failed.',
    assertNotAborted: () => {
      if (signal.aborted) throw new OperationCancelledError('Workflow execution was cancelled.', { scope: 'workflow' })
    },
  })
}
import { z } from 'zod'
