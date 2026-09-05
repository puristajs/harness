import { createHash } from 'node:crypto'

import type {
  ExecutionEvent,
  HarnessInterrupt,
  HarnessTargetStream,
  JsonValue,
  ToolApprovalDecision,
  ToolApprovalInterrupt,
  ToolApprovalResume,
} from '@purista/harness'
import {
  createUIMessageStreamResponse,
  isToolUIPart,
  validateUIMessages,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'

/** Protocol marker stored with every approval request in the UI message. */
export const HARNESS_UI_APPROVAL_PROTOCOL = 'purista-harness/tool-approval' as const
/** Wire format version of the approval descriptor. */
export const HARNESS_UI_APPROVAL_VERSION = 1 as const
/** Reserved HTTP headers required by AI SDK UI Message Stream v1 clients. */
export const AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
})

/** Durable information the browser returns to resume one approval batch. */
export interface HarnessUIApprovalDescriptor {
  readonly protocol: typeof HARNESS_UI_APPROVAL_PROTOCOL
  readonly version: typeof HARNESS_UI_APPROVAL_VERSION
  readonly rootRunId: string
  readonly agentRunId: string
  readonly sessionId: string
  readonly interruptId: string
  readonly revision: string
  readonly eventId: string
  readonly approvalIds: readonly string[]
}

type SubagentStatusBase = Readonly<{
  runId: string
  agentId: string
  parentAgentId: string
  delegationCallId: string
  delegationDepth: number
  parentRunId?: string
  parentInvocationId?: string
}>
type HarnessExecutionError = Extract<
  Extract<ExecutionEvent, { type: 'run.finished' }>['outcome'],
  { status: 'failed' | 'cancelled' }
>['error']

/** Framework-neutral lifecycle data rendered by an AI SDK or AI Elements UI. */
export type HarnessUIStatus =
  | Readonly<{ phase: 'started'; runId: string }>
  | Readonly<{ phase: 'tool-running'; runId: string; agentId: string; toolId: string; callId: string }>
  | (SubagentStatusBase & Readonly<{ phase: 'subagent-started' | 'subagent-completed'; error?: never }>)
  | (SubagentStatusBase & Readonly<{ phase: 'subagent-failed'; error: HarnessExecutionError }>)
  | Readonly<{ phase: 'media-progress'; runId: string; operation: 'video'; state: 'queued' | 'running'; progress?: number }>
  | Readonly<{ phase: 'completed'; runId: string }>
  | Readonly<{ phase: 'interrupted'; runId: string; interrupt: HarnessInterrupt }>
  | Readonly<{ phase: 'failed' | 'cancelled'; runId: string; error: HarnessExecutionError }>

/** Custom data parts emitted beside standard text and tool chunks. */
export interface HarnessUIDataTypes extends UIDataTypes {
  status: HarnessUIStatus
  output: { readonly runId: string; readonly value: JsonValue }
}
/** UI message accepted by request and approval helpers. */
export type HarnessUIMessage = UIMessage<unknown, HarnessUIDataTypes>

/** Options controlling execution-event projection. */
export interface HarnessUIMessageStreamOptions {
  readonly sessionId: string
  readonly messageId?: string
  readonly onIgnoredEvent?: (type: string) => void
}

/** Validated transport request prepared for an application-owned target call. */
export interface ParsedHarnessUIMessageRequest {
  readonly sessionId: string
  readonly messages: readonly HarnessUIMessage[]
  readonly lastUserMessage: HarnessUIMessage
  readonly assistantMessageId?: string
  readonly resume?: ToolApprovalResume
}

/** Data-only SSE record accepted by a host-owned stream writer. */
export type HarnessUIMessageSseEvent = Readonly<{ event: 'data'; data: UIMessageChunk<unknown, HarnessUIDataTypes> | '[DONE]' }>
/** Standard Response options plus Harness projection settings. */
export type HarnessUIMessageStreamResponseOptions = Omit<Parameters<typeof createUIMessageStreamResponse>[0], 'stream'> & HarnessUIMessageStreamOptions

/** Validate a standard AI SDK DefaultChatTransport request. */
export async function parseHarnessUIMessageRequest(body: unknown): Promise<ParsedHarnessUIMessageRequest> {
  if (!isRecord(body)) throw new TypeError('Harness UI request body must be an object.')
  const sessionId = nonEmpty(body['id'], 'id')
  if (body['trigger'] !== 'submit-message' && body['trigger'] !== 'regenerate-message') {
    throw new TypeError('Harness UI request trigger must be submit-message or regenerate-message.')
  }
  if (!Array.isArray(body['messages'])) throw new TypeError('Harness UI request messages must be an array.')
  const messageId = body['messageId'] === undefined ? undefined : nonEmpty(body['messageId'], 'messageId')
  if (body['trigger'] === 'regenerate-message' && messageId === undefined) {
    throw new TypeError('Harness UI regenerate-message requests require messageId.')
  }
  const messages = await validateUIMessages<HarnessUIMessage>({ messages: body['messages'] })
  const lastUserMessage = findLastByRole(messages, 'user')
  if (!lastUserMessage) throw new TypeError('Harness UI request requires a user message.')
  const resume = parseHarnessToolApprovalResume(messages)
  const finalMessage = messages.at(-1)
  const lastAssistant = finalMessage?.role === 'assistant' ? finalMessage : undefined
  const pendingDescriptor = lastAssistant === undefined ? undefined : findPendingHarnessDescriptor(lastAssistant)
  let assistantMessageId: string | undefined
  if (pendingDescriptor !== undefined) {
    if (pendingDescriptor.sessionId !== sessionId) {
      throw new TypeError('Harness UI approval session does not match the transport session.')
    }
    if (resume === undefined) throw new TypeError('Harness UI approval continuation is incomplete.')
    if (!lastAssistant || messageId !== lastAssistant.id) {
      throw new TypeError('Harness UI approval continuation messageId must identify the last assistant message.')
    }
    assistantMessageId = lastAssistant.id
  } else if (body['trigger'] === 'regenerate-message') {
    assistantMessageId = messageId
  }
  return Object.freeze({ sessionId, messages: Object.freeze(messages), lastUserMessage,
    ...(assistantMessageId === undefined ? {} : { assistantMessageId }), ...(resume === undefined ? {} : { resume }) })
}

/** Convert native Harness target events to AI SDK UI Message Stream v1 chunks. */
export function createHarnessUIMessageStream<Output extends JsonValue = JsonValue>(
  events: HarnessTargetStream<Output>,
  options: HarnessUIMessageStreamOptions,
): ReadableStream<UIMessageChunk<unknown, HarnessUIDataTypes>> {
  nonEmpty(options.sessionId, 'sessionId')
  if (events === null || typeof events !== 'object' || typeof events.cancel !== 'function'
    || typeof events[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Harness UI streaming requires a HarnessTargetStream.')
  }
  const iterator = events[Symbol.asyncIterator]()
  let rootRunId: string | undefined
  let rootTerminalSeen = false
  let activeTurnId: string | undefined
  let activeTextId: string | undefined
  let cancelled = false
  let cleanupPromise: Promise<void> | undefined
  const projectedToolCallIds = new Set<string>()

  const cleanup = (reason?: string): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise
    cancelled = true
    cleanupPromise = (async () => {
      let failure: unknown
      try { await events.cancel(reason) } catch (error) { failure = error }
      try { await iterator.return?.() } catch (error) { if (failure === undefined) failure = error }
      if (failure !== undefined) throw failure
    })()
    return cleanupPromise
  }

  const ignored = (type: string) => { try { options.onIgnoredEvent?.(type) } catch {} }
  const closeText = (controller: ChunkController) => {
    if (activeTextId !== undefined) controller.enqueue({ type: 'text-end', id: activeTextId })
    activeTextId = undefined
  }
  const closeTurn = (controller: ChunkController) => {
    if (activeTurnId === undefined) return
    closeText(controller)
    controller.enqueue({ type: 'finish-step' })
    activeTurnId = undefined
  }
  const openTurn = (id: string, controller: ChunkController) => {
    if (activeTurnId === id) return
    closeTurn(controller)
    activeTurnId = id
    controller.enqueue({ type: 'start-step' })
  }

  return new ReadableStream<UIMessageChunk<unknown, HarnessUIDataTypes>>({
    async pull(controller) {
      if (cancelled) return
      try {
        while (true) {
        const next = await iterator.next()
        if (next.done) {
          if (!rootTerminalSeen) throw new TypeError('Harness target stream ended without a direct terminal event.')
          controller.close()
          return
        }
        const current = next.value
        if (rootTerminalSeen) throw new TypeError('Harness target stream emitted an event after its direct terminal event.')
        if (rootRunId === undefined) {
          if (current.type !== 'run.started' || current.parentRunId !== undefined || current.parentInvocationId !== undefined) {
            throw new TypeError('Harness target stream must begin with a parentless root run.started event.')
          }
          rootRunId = current.runId
          controller.enqueue({ type: 'start', messageId: options.messageId ?? current.runId })
          controller.enqueue(statusChunk(current.runId, { phase: 'started', runId: current.runId }))
          return
        }

        switch (current.type) {
          case 'run.started':
            if (current.parentRunId === undefined && current.parentInvocationId === undefined) {
              throw new TypeError('Harness target stream emitted a second root run.started event.')
            }
            ignored(current.type)
            continue
          case 'run.finished':
            if (current.runId !== rootRunId) { ignored(current.type); continue }
            rootTerminalSeen = true
            enqueueTerminal(controller, current, options.sessionId, projectedToolCallIds, closeText, closeTurn)
            break
          case 'output.text.delta':
            openTurn(current.id, controller)
            if (activeTextId !== current.id) {
              closeText(controller)
              activeTextId = current.id
              controller.enqueue({ type: 'text-start', id: current.id })
            }
            controller.enqueue({ type: 'text-delta', id: current.id, delta: current.delta })
            break
          case 'output.object.snapshot':
            openTurn(current.id, controller)
            controller.enqueue({ type: 'data-output', id: `harness-output:${current.runId}:${current.id}`,
              data: { runId: current.runId, value: current.value }, transient: true })
            break
          case 'model.completed':
            if ((current.streamId ?? activeTurnId ?? current.eventId) === activeTurnId) continue
            openTurn(current.streamId ?? current.eventId, controller)
            break
          case 'tool.input.available':
            projectedToolCallIds.add(current.callId)
            controller.enqueue({ type: 'tool-input-available', toolCallId: current.callId, toolName: current.toolId, input: current.input, dynamic: true })
            break
          case 'tool.started':
            controller.enqueue(statusChunk(current.runId, { phase: 'tool-running', runId: current.runId, agentId: current.agentId, toolId: current.toolId, callId: current.callId }))
            break
          case 'tool.finished':
            controller.enqueue(current.error === undefined
              ? { type: 'tool-output-available', toolCallId: current.callId, output: current.output ?? null, dynamic: true }
              : { type: 'tool-output-error', toolCallId: current.callId, errorText: current.error.message, dynamic: true })
            break
          case 'approval.requested':
            continue
          case 'approval.responded':
            controller.enqueue({ type: 'tool-approval-response', approvalId: current.approvalId, approved: current.approved })
            break
          case 'output.file':
            controller.enqueue({ type: 'file', url: current.artifact.url, mediaType: current.artifact.mediaType })
            break
          case 'output.progress':
            controller.enqueue(statusChunk(current.runId, { phase: 'media-progress', runId: current.runId, operation: current.operation,
              state: current.state, ...(current.progress === undefined ? {} : { progress: current.progress }) }))
            break
          case 'agent.started':
            if (isSubagentEvent(current)) controller.enqueue(statusChunk(current.runId, { phase: 'subagent-started', ...subagentStatus(current) }))
            else { ignored(current.type); continue }
            break
          case 'agent.finished':
            if (isSubagentEvent(current)) controller.enqueue(statusChunk(current.runId, current.error === undefined
              ? { phase: 'subagent-completed', ...subagentStatus(current) }
              : { phase: 'subagent-failed', ...subagentStatus(current), error: current.error }))
            else { ignored(current.type); continue }
            break
          default:
            ignored(current.type)
            continue
        }
        return
        }
      } catch (error) {
        try { await cleanup('AI SDK UI stream projection failed') } catch {}
        controller.error(error)
      }
    },
    async cancel(reason) {
      await cleanup(typeof reason === 'string' ? reason : undefined)
    },
  })
}

/** Return the standard AI SDK-owned, fully framed SSE response. */
export function createHarnessUIMessageStreamResponse<Output extends JsonValue = JsonValue>(
  events: HarnessTargetStream<Output>, options: HarnessUIMessageStreamResponseOptions,
): Response {
  const { sessionId, messageId, onIgnoredEvent, ...responseOptions } = options
  const response = createUIMessageStreamResponse({ ...responseOptions,
    stream: createHarnessUIMessageStream(events, { sessionId, ...(messageId === undefined ? {} : { messageId }),
      ...(onIgnoredEvent === undefined ? {} : { onIgnoredEvent }) }) })
  for (const [name, value] of Object.entries(AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS)) response.headers.set(name, value)
  return response
}

/** Return data-only protocol records for a host that owns SSE framing. */
export async function* createHarnessUIMessageSseEvents<Output extends JsonValue = JsonValue>(
  events: HarnessTargetStream<Output>, options: HarnessUIMessageStreamOptions,
): AsyncIterable<HarnessUIMessageSseEvent> {
  const reader = createHarnessUIMessageStream(events, options).getReader()
  let completed = false
  try {
    while (true) { const next = await reader.read(); if (next.done) break; yield { event: 'data', data: next.value } }
    completed = true
    yield { event: 'data', data: '[DONE]' }
  } finally {
    if (!completed) await reader.cancel('consumer stopped reading')
    reader.releaseLock()
  }
}

/** Parse the latest complete Harness approval response batch. */
export function parseHarnessToolApprovalResume(messages: readonly UIMessage[]): ToolApprovalResume | undefined {
  const assistant = messages.at(-1)
  if (assistant?.role !== 'assistant') return undefined
  let descriptor: HarnessUIApprovalDescriptor | undefined
  const decisions = new Map<string, ToolApprovalDecision>()
  let sawHarnessApproval = false
  let sawNonResponseState = false
  for (const part of currentStepParts(assistant)) {
    if (!isToolUIPart(part) || !part.approval || !isHarnessApprovalMarker(part.approval.descriptor)) continue
    sawHarnessApproval = true
    const parsed = parseApprovalDescriptor(part.approval.descriptor)
    if (descriptor && !sameDescriptor(descriptor, parsed)) throw new TypeError('The assistant message contains conflicting Harness approval descriptors.')
    descriptor = parsed
    if (part.state !== 'approval-responded') { sawNonResponseState = true; continue }
    const approvalId = part.approval.id
    if (!parsed.approvalIds.includes(approvalId)) throw new TypeError(`Harness approval ${approvalId} is not part of the declared approval batch.`)
    if (decisions.has(approvalId)) throw new TypeError(`Harness approval ${approvalId} appears more than once.`)
    decisions.set(approvalId, { approvalId, approved: part.approval.approved, ...(part.approval.reason ? { reason: part.approval.reason } : {}) })
  }
  if (!sawHarnessApproval || !descriptor || sawNonResponseState || decisions.size !== descriptor.approvalIds.length) return undefined
  const ordered = descriptor.approvalIds.map(approvalId => {
    const decision = decisions.get(approvalId)
    if (!decision) throw new TypeError(`Harness approval ${approvalId} has no decision.`)
    return decision
  })
  return Object.freeze({ type: 'tool-approval', runId: descriptor.rootRunId, interruptId: descriptor.interruptId,
    revision: descriptor.revision, eventId: createResumeEventId(descriptor, ordered), decisions: Object.freeze(ordered) })
}

type ChunkController = ReadableStreamDefaultController<UIMessageChunk<unknown, HarnessUIDataTypes>>
type SubagentEvent = Extract<ExecutionEvent, { type: 'agent.started' | 'agent.finished' }> & {
  parentAgentId: string; delegationCallId: string; delegationDepth: number
}

function enqueueTerminal(
  controller: ChunkController,
  event: Extract<ExecutionEvent, { type: 'run.finished' }>,
  sessionId: string,
  projectedToolCallIds: Set<string>,
  closeText: (controller: ChunkController) => void,
  closeTurn: (controller: ChunkController) => void,
): void {
  const outcome = event.outcome
  if (outcome.status === 'completed') {
    closeText(controller)
    controller.enqueue(statusChunk(event.runId, { phase: 'completed', runId: event.runId }))
    closeTurn(controller)
    controller.enqueue({ type: 'finish', finishReason: 'stop' })
    return
  }
  if (outcome.status === 'interrupted') {
    if (outcome.interrupt.type === 'tool-approval') enqueueApprovalRequests(controller, event, outcome.interrupt, sessionId, projectedToolCallIds)
    controller.enqueue(statusChunk(event.runId, { phase: 'interrupted', runId: event.runId, interrupt: outcome.interrupt }))
    closeTurn(controller)
    controller.enqueue({ type: 'finish', finishReason: outcome.interrupt.type === 'tool-approval' ? 'tool-calls' : 'other' })
    return
  }
  controller.enqueue(statusChunk(event.runId, { phase: outcome.status, runId: event.runId, error: outcome.error }))
  controller.enqueue(outcome.status === 'failed' ? { type: 'error', errorText: outcome.error.message } : { type: 'abort', reason: outcome.error.message })
  closeTurn(controller)
  controller.enqueue({ type: 'finish', finishReason: outcome.status === 'failed' ? 'error' : 'other' })
}

function enqueueApprovalRequests(
  controller: ChunkController,
  terminal: Extract<ExecutionEvent, { type: 'run.finished' }>,
  interrupt: ToolApprovalInterrupt,
  sessionId: string,
  projectedToolCallIds: Set<string>,
): void {
  const first = interrupt.requests[0]
  if (!first) throw new TypeError('A Harness tool approval interrupt must contain at least one request.')
  if (terminal.runId !== first.runId || interrupt.requests.some(request => request.runId !== first.runId
    || request.agentRunId !== first.agentRunId || request.parentRunId !== first.parentRunId
    || request.parentInvocationId !== first.parentInvocationId || request.agentId !== first.agentId
    || request.invocationId !== first.invocationId)) {
    throw new TypeError('Harness tool approval interrupt has invalid run correlation.')
  }
  const approvalIds = interrupt.requests.map(request => request.approvalId)
  if (new Set(approvalIds).size !== approvalIds.length) throw new TypeError('Harness tool approval interrupt contains duplicate approval ids.')
  const descriptor: HarnessUIApprovalDescriptor = Object.freeze({ protocol: HARNESS_UI_APPROVAL_PROTOCOL, version: HARNESS_UI_APPROVAL_VERSION,
    rootRunId: first.runId, agentRunId: first.agentRunId, sessionId, interruptId: interrupt.id, revision: interrupt.revision,
    eventId: terminal.eventId, approvalIds: Object.freeze(approvalIds) })
  for (const request of interrupt.requests) {
    if (!projectedToolCallIds.has(request.callId)) {
      controller.enqueue({ type: 'tool-input-available', toolCallId: request.callId, toolName: request.toolId,
        input: request.input, dynamic: true })
      projectedToolCallIds.add(request.callId)
    }
    const reasonCodes = request.demands.flatMap(demand => demand.reasonCode ? [demand.reasonCode] : [])
    controller.enqueue({ type: 'tool-approval-request', approvalId: request.approvalId, toolCallId: request.callId,
      approvalDescriptor: descriptor, ...(reasonCodes.length === 0 ? {} : { reason: reasonCodes.join(', ') }) })
  }
}

function statusChunk(runId: string, data: HarnessUIStatus): UIMessageChunk<unknown, HarnessUIDataTypes> {
  return { type: 'data-status', id: `harness-status:${runId}`, data }
}
function isSubagentEvent(event: Extract<ExecutionEvent, { type: 'agent.started' | 'agent.finished' }>): event is SubagentEvent {
  return typeof event.parentAgentId === 'string' && typeof event.delegationCallId === 'string' && typeof event.delegationDepth === 'number'
}
function subagentStatus(event: SubagentEvent): SubagentStatusBase {
  return { runId: event.runId, agentId: event.agentId, parentAgentId: event.parentAgentId,
    delegationCallId: event.delegationCallId, delegationDepth: event.delegationDepth,
    ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
    ...(event.parentInvocationId === undefined ? {} : { parentInvocationId: event.parentInvocationId }) }
}
function findLastByRole<T extends UIMessage>(messages: readonly T[], role: 'user' | 'assistant'): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]?.role === role) return messages[index]
  return undefined
}
function findPendingHarnessDescriptor(message: UIMessage): HarnessUIApprovalDescriptor | undefined {
  for (const part of currentStepParts(message)) if (isToolUIPart(part) && part.approval
    && (part.state === 'approval-requested' || part.state === 'approval-responded')
    && isHarnessApprovalMarker(part.approval.descriptor)) return parseApprovalDescriptor(part.approval.descriptor)
  return undefined
}
function currentStepParts(message: UIMessage): UIMessage['parts'] {
  let start = 0
  for (let index = 0; index < message.parts.length; index += 1) {
    if (message.parts[index]?.type === 'step-start') start = index + 1
  }
  return message.parts.slice(start)
}
function isHarnessApprovalMarker(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['protocol'] === HARNESS_UI_APPROVAL_PROTOCOL
}
function parseApprovalDescriptor(value: unknown): HarnessUIApprovalDescriptor {
  if (!isHarnessApprovalMarker(value)) throw new TypeError('Expected a Harness approval descriptor.')
  const keys = Object.keys(value).sort()
  const expected = ['agentRunId', 'approvalIds', 'eventId', 'interruptId', 'protocol', 'revision', 'rootRunId', 'sessionId', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || value['version'] !== HARNESS_UI_APPROVAL_VERSION
    || !validStringFields(value, ['rootRunId', 'agentRunId', 'sessionId', 'interruptId', 'revision', 'eventId'])
    || !Array.isArray(value['approvalIds']) || value['approvalIds'].length === 0
    || !value['approvalIds'].every(id => typeof id === 'string' && id.length > 0)
    || new Set(value['approvalIds']).size !== value['approvalIds'].length) throw new TypeError('Invalid Harness approval descriptor.')
  return Object.freeze({ protocol: HARNESS_UI_APPROVAL_PROTOCOL, version: HARNESS_UI_APPROVAL_VERSION,
    rootRunId: value['rootRunId'] as string, agentRunId: value['agentRunId'] as string, sessionId: value['sessionId'] as string,
    interruptId: value['interruptId'] as string, revision: value['revision'] as string, eventId: value['eventId'] as string,
    approvalIds: Object.freeze([...(value['approvalIds'] as string[])]) })
}
function sameDescriptor(left: HarnessUIApprovalDescriptor, right: HarnessUIApprovalDescriptor): boolean {
  return left.protocol === right.protocol && left.version === right.version && left.rootRunId === right.rootRunId
    && left.agentRunId === right.agentRunId && left.sessionId === right.sessionId && left.interruptId === right.interruptId
    && left.revision === right.revision && left.eventId === right.eventId && left.approvalIds.length === right.approvalIds.length
    && left.approvalIds.every((id, index) => id === right.approvalIds[index])
}
function createResumeEventId(descriptor: HarnessUIApprovalDescriptor, decisions: readonly ToolApprovalDecision[]): string {
  const digest = createHash('sha256').update(JSON.stringify([
    descriptor.protocol, descriptor.version, descriptor.rootRunId, descriptor.agentRunId, descriptor.sessionId,
    descriptor.interruptId, descriptor.revision, descriptor.eventId, descriptor.approvalIds,
    decisions.map(decision => [decision.approvalId, decision.approved, decision.reason ?? null]),
  ])).digest('hex')
  return `ui_approval_${digest}`
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Harness UI request ${field} must be a non-empty string.`)
  return value
}
function validStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'string' && (value[field] as string).length > 0)
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
