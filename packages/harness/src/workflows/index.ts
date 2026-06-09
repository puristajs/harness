import { z } from 'zod'
import { OperationCancelledError, ValidationError } from '../errors/index.js'
import type { BuilderState, InvokeOptions, WorkflowContext, WorkflowDefinition } from '../harness/defineHarness.js'
import { withAbortSignal } from '../runtime/abort.js'

export async function runWorkflow<S extends BuilderState>(args: {
  workflowId: string
  workflow: WorkflowDefinition<S, any, any>
  input: unknown
  ctx: Omit<WorkflowContext<S, unknown, unknown>, 'input'>
  opts?: InvokeOptions
}): Promise<unknown> {
  if (args.ctx['signal'].aborted) throw new OperationCancelledError('Workflow execution was cancelled.', { scope: 'workflow' })
  const schema = args.workflow.input
  let parsed: unknown
  try {
    parsed = schema ? schema.parse(args.input) : args.input
  } catch (error) {
    throw new ValidationError('Workflow input validation failed.', { where: 'workflow_input', issues: validationIssues(error) }, error)
  }
  const output = await withAbortSignal(args.ctx['signal'], 'workflow', 'Workflow execution was cancelled.', () =>
    args.workflow.handler({ ...(args.ctx as WorkflowContext<S, unknown, unknown>), input: parsed }))
  if (args.ctx['signal'].aborted) throw new OperationCancelledError('Workflow execution was cancelled.', { scope: 'workflow' })
  if (!args.workflow.output) return output
  try {
    return args.workflow.output.parse(output)
  } catch (error) {
    throw new ValidationError('Workflow output validation failed.', { where: 'workflow_output', issues: validationIssues(error) }, error)
  }
}

function validationIssues(error: unknown): unknown {
  return error instanceof z.ZodError ? JSON.parse(JSON.stringify(error.issues)) : error
}
