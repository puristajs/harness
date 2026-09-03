import { createHash } from 'node:crypto'

import type {
  ExecutionEvent,
  HarnessInterrupt,
  JsonValue,
  ToolApprovalDecision,
  ToolApprovalInterrupt,
  ToolApprovalResume,
} from '@purista/harness'
import {
  createUIMessageStreamResponse,
  isToolUIPart,
  type UIDataTypes,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'

/** Protocol marker stored with every approval request in the UI message. */
export const HARNESS_UI_APPROVAL_PROTOCOL = 'purista-harness/tool-approval' as const

/** Wire format version of the approval descriptor. */
export const HARNESS_UI_APPROVAL_VERSION = 1 as const

/** Static HTTP header required by AI SDK UI Message Stream v1 clients. */
export const AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS = Object.freeze({
  'x-vercel-ai-ui-message-stream': 'v1',
})

/** Durable information the browser must return to resume one approval batch. */
export interface HarnessUIApprovalDescriptor {
  readonly protocol: typeof HARNESS_UI_APPROVAL_PROTOCOL
  readonly version: typeof HARNESS_UI_APPROVAL_VERSION
  readonly runId: string
  readonly interruptId: string
  readonly revision: string
  readonly approvalIds: readonly string[]
}

/** Framework-neutral lifecycle data rendered by an AI SDK or AI Elements UI. */
export type HarnessUIStatus =
  | { readonly phase: 'started'; readonly runId: string }
  | {
      readonly phase: 'tool-running'
      readonly runId: string
      readonly toolId: string
      readonly callId: string
    }
  | { readonly phase: 'completed'; readonly runId: string }
  | {
      readonly phase: 'media-progress'
      readonly runId: string
      readonly operation: 'video'
      readonly state: 'queued' | 'running'
      readonly progress?: number
    }
  | { readonly phase: 'interrupted'; readonly runId: string; readonly interrupt: HarnessInterrupt }

/** Custom data parts emitted beside standard text and tool chunks. */
export interface HarnessUIDataTypes extends UIDataTypes {
  status: HarnessUIStatus
  output: { readonly runId: string; readonly value: JsonValue }
}

/** UI message type accepted by the approval resume helper. */
export type HarnessUIMessage = UIMessage<unknown, HarnessUIDataTypes>

/** Options that control conversion to an AI SDK UI Message Stream. */
export interface HarnessUIMessageStreamOptions {
  /**
   * Assistant message to create or continue. Pass the last assistant message
   * id when resuming approval so `useChat` updates that message in place.
   */
  readonly messageId?: string
}

/** Data-only SSE event accepted by HTTP adapters such as PURISTA Hono. */
export type HarnessUIMessageSseEvent = Readonly<{
  event: 'data'
  data: UIMessageChunk<unknown, HarnessUIDataTypes> | '[DONE]'
}>

/** Response options plus adapter-specific stream settings. */
export type HarnessUIMessageStreamResponseOptions = Omit<
  Parameters<typeof createUIMessageStreamResponse>[0],
  'stream'
> & { readonly messageId?: string }

/**
 * Convert native Harness execution events to AI SDK UI Message Stream v1.
 *
 * Text and tool activity use standard AI SDK chunks. Harness lifecycle and
 * structured output use typed `data-*` parts, which AI Elements can render or
 * ignore without affecting chat compatibility.
 */
export function createHarnessUIMessageStream<Output extends JsonValue = JsonValue>(
  events: AsyncIterable<ExecutionEvent<Output>>,
  options: HarnessUIMessageStreamOptions = {},
): ReadableStream<UIMessageChunk<unknown, HarnessUIDataTypes>> {
  const iterator = events[Symbol.asyncIterator]()
  const activeTextIds = new Set<string>()
  let terminal = false

  const closeTextParts = (controller: ReadableStreamDefaultController<UIMessageChunk<unknown, HarnessUIDataTypes>>) => {
    for (const id of activeTextIds) controller.enqueue({ type: 'text-end', id })
    activeTextIds.clear()
  }

  return new ReadableStream<UIMessageChunk<unknown, HarnessUIDataTypes>>({
    async pull(controller) {
      if (terminal) return
      try {
        while (!terminal) {
          const next = await iterator.next()
          if (next.done) {
            closeTextParts(controller)
            terminal = true
            controller.close()
            return
          }

          const event = next.value
          switch (event.type) {
            case 'run.started': {
              controller.enqueue({ type: 'start', messageId: options.messageId ?? event.runId })
              controller.enqueue({ type: 'start-step' })
              controller.enqueue(statusChunk(event.runId, { phase: 'started', runId: event.runId }))
              break
            }
            case 'output.text.delta': {
              if (!activeTextIds.has(event.id)) {
                activeTextIds.add(event.id)
                controller.enqueue({ type: 'text-start', id: event.id })
              }
              controller.enqueue({ type: 'text-delta', id: event.id, delta: event.delta })
              break
            }
            case 'output.object.snapshot': {
              controller.enqueue({
                type: 'data-output',
                id: `harness-output:${event.runId}:${event.id}`,
                data: { runId: event.runId, value: event.value },
              })
              break
            }
            case 'output.file': {
              controller.enqueue({
                type: 'file',
                url: event.artifact.url,
                mediaType: event.artifact.mediaType,
              })
              break
            }
            case 'output.progress': {
              controller.enqueue(statusChunk(event.runId, {
                phase: 'media-progress',
                runId: event.runId,
                operation: event.operation,
                state: event.state,
                ...(event.progress !== undefined ? { progress: event.progress } : {}),
              }))
              break
            }
            case 'tool.input.available': {
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: event.callId,
                toolName: event.toolId,
                input: event.input,
                dynamic: true,
              })
              break
            }
            case 'tool.started': {
              controller.enqueue(
                statusChunk(event.runId, {
                  phase: 'tool-running',
                  runId: event.runId,
                  toolId: event.toolId,
                  callId: event.callId,
                }),
              )
              break
            }
            case 'tool.finished': {
              if (event.error) {
                controller.enqueue({
                  type: 'tool-output-error',
                  toolCallId: event.callId,
                  errorText: event.error.message,
                  dynamic: true,
                })
              } else {
                controller.enqueue({
                  type: 'tool-output-available',
                  toolCallId: event.callId,
                  output: event.output ?? null,
                  dynamic: true,
                })
              }
              break
            }
            case 'approval.requested':
              // The terminal interrupt carries the durable batch descriptor.
              // It is emitted there so the browser receives all resume fields.
              continue
            case 'approval.responded': {
              controller.enqueue({
                type: 'tool-approval-response',
                approvalId: event.approvalId,
                approved: event.approved,
              })
              break
            }
            case 'run.finished': {
              closeTextParts(controller)
              if (event.outcome.status === 'interrupted' && event.outcome.interrupt.type === 'tool-approval') {
                enqueueApprovalRequests(controller, event.outcome.interrupt)
              }
              controller.enqueue(
                event.outcome.status === 'completed'
                  ? statusChunk(event.runId, { phase: 'completed', runId: event.runId })
                  : statusChunk(event.runId, {
                      phase: 'interrupted',
                      runId: event.runId,
                      interrupt: event.outcome.interrupt,
                    }),
              )
              controller.enqueue({ type: 'finish-step' })
              controller.enqueue({
                type: 'finish',
                finishReason:
                  event.outcome.status === 'completed'
                    ? 'stop'
                    : event.outcome.interrupt.type === 'tool-approval'
                      ? 'tool-calls'
                      : 'other',
              })
              terminal = true
              controller.close()
              break
            }
          }
          return
        }
      } catch (error) {
        terminal = true
        controller.error(error)
      }
    },
    async cancel(reason) {
      terminal = true
      await iterator.return?.(reason)
    },
  })
}

/**
 * Return a standards-compliant AI SDK UI Message Stream v1 SSE response.
 *
 * The AI SDK supplies the protocol header, SSE framing, and `[DONE]` marker.
 */
export function createHarnessUIMessageStreamResponse<Output extends JsonValue = JsonValue>(
  events: AsyncIterable<ExecutionEvent<Output>>,
  options: HarnessUIMessageStreamResponseOptions = {},
): Response {
  const { messageId, ...responseInit } = options
  return createUIMessageStreamResponse({
    ...responseInit,
    stream: createHarnessUIMessageStream(events, { ...(messageId ? { messageId } : {}) }),
  })
}

/**
 * Convert Harness events to data-only SSE events for a framework HTTP stream.
 *
 * Use this when the framework owns the response and SSE framing. The final
 * event contains the AI SDK `[DONE]` sentinel. Stopping iteration cancels the
 * underlying Harness event stream.
 */
export async function* createHarnessUIMessageSseEvents<Output extends JsonValue = JsonValue>(
  events: AsyncIterable<ExecutionEvent<Output>>,
  options: HarnessUIMessageStreamOptions = {},
): AsyncIterable<HarnessUIMessageSseEvent> {
  const reader = createHarnessUIMessageStream(events, options).getReader()
  let completed = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      yield { event: 'data', data: next.value }
    }
    completed = true
    yield { event: 'data', data: '[DONE]' }
  } finally {
    if (!completed) await reader.cancel('consumer stopped reading')
    reader.releaseLock()
  }
}

/**
 * Read a completed AI SDK tool approval batch and create a Harness resume.
 *
 * Returns `undefined` while no Harness approval is present or while the user
 * has not answered every request in the batch. Malformed or contradictory
 * Harness descriptors throw before an invocation reaches the event bridge.
 */
export function parseHarnessToolApprovalResume(
  messages: readonly UIMessage[],
): ToolApprovalResume | undefined {
  const assistant = findLastAssistant(messages)
  if (!assistant) return undefined

  let descriptor: HarnessUIApprovalDescriptor | undefined
  const decisions = new Map<string, ToolApprovalDecision>()
  let sawHarnessApproval = false

  for (const part of assistant.parts) {
    if (!isToolUIPart(part) || !part.approval) continue
    const candidate = part.approval.descriptor
    if (!isHarnessApprovalMarker(candidate)) continue
    sawHarnessApproval = true
    const parsed = parseApprovalDescriptor(candidate)
    if (descriptor && !sameDescriptor(descriptor, parsed)) {
      throw new TypeError('The assistant message contains conflicting Harness approval descriptors.')
    }
    descriptor = parsed

    // `approval-responded` exists only between the user's decision and the
    // resumed server stream. Output states belong to an already handled run
    // and must never trigger that old resume again on a later user message.
    if (part.state !== 'approval-responded') continue
    const approvalId = part.approval.id
    if (!parsed.approvalIds.includes(approvalId)) {
      throw new TypeError(`Harness approval ${approvalId} is not part of the declared approval batch.`)
    }
    if (decisions.has(approvalId)) {
      throw new TypeError(`Harness approval ${approvalId} appears more than once.`)
    }
    decisions.set(approvalId, {
      approvalId,
      approved: part.approval.approved,
      ...(part.approval.reason ? { reason: part.approval.reason } : {}),
    })
  }

  if (!sawHarnessApproval || !descriptor) return undefined
  if (decisions.size !== descriptor.approvalIds.length) return undefined

  const ordered = descriptor.approvalIds.map(approvalId => {
    const decision = decisions.get(approvalId)
    if (!decision) throw new TypeError(`Harness approval ${approvalId} has no decision.`)
    return decision
  })

  return {
    type: 'tool-approval',
    runId: descriptor.runId,
    interruptId: descriptor.interruptId,
    revision: descriptor.revision,
    eventId: createResumeEventId(descriptor, ordered),
    decisions: ordered,
  }
}

function statusChunk(runId: string, data: HarnessUIStatus): UIMessageChunk<unknown, HarnessUIDataTypes> {
  return { type: 'data-status', id: `harness-status:${runId}`, data }
}

function enqueueApprovalRequests(
  controller: ReadableStreamDefaultController<UIMessageChunk<unknown, HarnessUIDataTypes>>,
  interrupt: ToolApprovalInterrupt,
): void {
  const firstRequest = interrupt.requests[0]
  if (!firstRequest) throw new TypeError('A Harness tool approval interrupt must contain at least one request.')
  const descriptor: HarnessUIApprovalDescriptor = {
    protocol: HARNESS_UI_APPROVAL_PROTOCOL,
    version: HARNESS_UI_APPROVAL_VERSION,
    runId: firstRequest.runId,
    interruptId: interrupt.id,
    revision: interrupt.revision,
    approvalIds: interrupt.requests.map(request => request.approvalId),
  }
  for (const request of interrupt.requests) {
    const reason = approvalReason(request.demands)
    controller.enqueue({
      type: 'tool-approval-request',
      approvalId: request.approvalId,
      toolCallId: request.callId,
      approvalDescriptor: descriptor,
      ...(reason ? { reason } : {}),
    })
  }
}

function approvalReason(demands: ToolApprovalInterrupt['requests'][number]['demands']): string | undefined {
  const reasonCodes = demands.flatMap(demand => (demand.reasonCode ? [demand.reasonCode] : []))
  return reasonCodes.length > 0 ? reasonCodes.join(', ') : undefined
}

function findLastAssistant(messages: readonly UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

function isHarnessApprovalMarker(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocol' in value &&
    value.protocol === HARNESS_UI_APPROVAL_PROTOCOL
  )
}

function parseApprovalDescriptor(value: unknown): HarnessUIApprovalDescriptor {
  if (!isHarnessApprovalMarker(value)) throw new TypeError('Expected a Harness approval descriptor.')
  const descriptor = value as Record<string, unknown>
  if (
    descriptor['version'] !== HARNESS_UI_APPROVAL_VERSION ||
    typeof descriptor['runId'] !== 'string' ||
    descriptor['runId'].length === 0 ||
    typeof descriptor['interruptId'] !== 'string' ||
    descriptor['interruptId'].length === 0 ||
    typeof descriptor['revision'] !== 'string' ||
    descriptor['revision'].length === 0 ||
    !Array.isArray(descriptor['approvalIds']) ||
    descriptor['approvalIds'].length === 0 ||
    !descriptor['approvalIds'].every(id => typeof id === 'string' && id.length > 0) ||
    new Set(descriptor['approvalIds']).size !== descriptor['approvalIds'].length
  ) {
    throw new TypeError('Invalid Harness approval descriptor.')
  }
  return {
    protocol: HARNESS_UI_APPROVAL_PROTOCOL,
    version: HARNESS_UI_APPROVAL_VERSION,
    runId: descriptor['runId'],
    interruptId: descriptor['interruptId'],
    revision: descriptor['revision'],
    approvalIds: descriptor['approvalIds'] as string[],
  }
}

function sameDescriptor(left: HarnessUIApprovalDescriptor, right: HarnessUIApprovalDescriptor): boolean {
  return (
    left.runId === right.runId &&
    left.interruptId === right.interruptId &&
    left.revision === right.revision &&
    left.approvalIds.length === right.approvalIds.length &&
    left.approvalIds.every((id, index) => id === right.approvalIds[index])
  )
}

function createResumeEventId(
  descriptor: HarnessUIApprovalDescriptor,
  decisions: readonly ToolApprovalDecision[],
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        descriptor.runId,
        descriptor.interruptId,
        descriptor.revision,
        decisions.map(decision => [decision.approvalId, decision.approved, decision.reason ?? null]),
      ]),
    )
    .digest('hex')
  return `ui_approval_${digest}`
}
