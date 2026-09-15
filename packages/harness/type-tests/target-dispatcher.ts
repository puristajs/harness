import { z } from 'zod'
import { defineAgent } from '../src/definitions/agent.js'
import type { HarnessTargetContract } from '../src/definitions/types.js'
import type { HarnessTargetDispatchRequest, HarnessTargetInput, HarnessTargetOutput } from '../src/ports/target-dispatcher.js'
import { createSubagentBinding } from '../src/runtime/subagent-execution.js'

const child = defineAgent('child', { model: 'chat', instructions: 'Help.', input: z.object({ id: z.string() }), output: z.object({ answer: z.string() }), prompt: value => ({ role: 'user', content: value.id }) })
const request: HarnessTargetDispatchRequest<typeof child.contract> = {
	target: child.contract, input: { id: '1' }, invocation: { sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', parentAgentId: 'parent-agent', depth: 1, remainingDepth: 0, signal: new AbortController().signal },
}
const exactInput: string = request.input.id
void exactInput
// @ts-expect-error exact target input is enforced
const badRequest: HarnessTargetDispatchRequest<typeof child.contract> = { ...request, input: { id: 1 } }
void badRequest

// @ts-expect-error public target dispatch always represents a nested agent or workflow call
const missingParentTarget: HarnessTargetDispatchRequest<typeof child.contract> = { ...request, invocation: { sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', depth: 1, remainingDepth: 0, signal: new AbortController().signal } }
void missingParentTarget

// @ts-expect-error nested dispatch ancestry identifies exactly one parent target
const conflictingParentTarget: HarnessTargetDispatchRequest<typeof child.contract> = { ...request, invocation: { ...request.invocation, parentAgentId: 'parent-agent', parentWorkflowId: 'parent-workflow' } }
void conflictingParentTarget

// @ts-expect-error only remaining depth crosses; local loop budgets are not transport fields
request.invocation.maxSteps = 3

const binding = createSubagentBinding('delegate', child)
const output: { answer: string } = null as never as Awaited<ReturnType<typeof binding.invokeValidated>>
void output

// @ts-expect-error trusted identity and ancestry belong only to the invocation envelope
const untrustedEnvelope: HarnessTargetDispatchRequest<typeof child.contract> = { target: child.contract, input: { id: '1' }, identity: { principalId: 'p' }, depth: 5 }
void untrustedEnvelope

const nonJson = z.string().transform(value => new Date(value))
// @ts-expect-error non-JSON inferred schema output cannot form a dispatcher target contract
type NonJsonTarget = HarnessTargetContract<'agent', 'nonJson', typeof nonJson, typeof nonJson, 'object-snapshot', readonly ['tool-approval']>
type NonJsonInput = HarnessTargetInput<NonJsonTarget>
type NonJsonOutput = HarnessTargetOutput<NonJsonTarget>
// @ts-expect-error a Date cannot cross the JSON target input boundary
const badNonJsonInput: NonJsonInput = new Date()
// @ts-expect-error a Date cannot cross the JSON target output boundary
const badNonJsonOutput: NonJsonOutput = new Date()
void badNonJsonInput
void badNonJsonOutput
