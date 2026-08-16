import type { JsonValue } from '../models/json.js'
import type { ModelCapability, ModelProvider, ObjectRequest, ObjectResponse, ObjectStreamChunk, TextRequest, TextResponse, TextStreamChunk } from '../ports/model-provider.js'

export type ReplayMethod = 'text' | 'object' | 'textStream' | 'objectStream'

export interface SanitizedReplayInteraction {
  readonly method: ReplayMethod
  readonly request: { readonly fingerprint: string; readonly providerId: string; readonly model: string; readonly value: JsonValue }
  readonly chunks?: readonly JsonValue[]
  readonly outcome: JsonValue
}

export interface SanitizedReplayFixture {
  readonly version: 1
  readonly id: string
  readonly interactions: readonly SanitizedReplayInteraction[]
}

export class ReplayFixtureError extends Error {
  public readonly code = 'REPLAY_FIXTURE_ERROR'
  public constructor(message: string, public readonly meta: { fixtureId: string; ordinal?: number; reason: 'invalid_fixture' | 'mismatch' | 'exhausted' | 'unused' | 'unsupported_method' }) {
    super(message)
    this.name = 'ReplayFixtureError'
  }
}

export interface ReplayInteractionRecorder {
  wrap(provider: ModelProvider): ModelProvider
  fixture(id: string): SanitizedReplayFixture
}

export interface ReplayModelProviderOptions {
  id?: string
  genAiSystem?: string
  capabilities?: readonly ModelCapability[]
}

const fingerprint = (method: ReplayMethod, request: { model: string }) => `${method}:${request.model}`

export function createReplayInteractionRecorder(options: { sanitize: (value: unknown) => unknown }): ReplayInteractionRecorder {
  if (typeof options?.sanitize !== 'function') throw new TypeError('Replay recording requires a sanitize callback.')
  const interactions: SanitizedReplayInteraction[] = []
  const record = (method: ReplayMethod, provider: ModelProvider, request: { model: string }, outcome: unknown, chunks?: readonly unknown[]) => {
    interactions.push({
      method,
      request: { fingerprint: fingerprint(method, request), providerId: provider.id, model: request.model, value: options.sanitize(request) as JsonValue },
      ...(chunks ? { chunks: chunks.map((chunk) => options.sanitize(chunk) as JsonValue) } : {}),
      outcome: options.sanitize(outcome) as JsonValue
    })
  }
  return {
    wrap(provider) {
      return {
        ...provider,
        ...(provider.text ? { text: async (request: TextRequest) => { const outcome = await provider.text!(request); record('text', provider, request, outcome); return outcome } } : {}),
        ...(provider.object ? { object: async <T extends JsonValue>(request: ObjectRequest<T>) => { const outcome = await provider.object!(request); record('object', provider, request, outcome); return outcome } } : {}),
        ...(provider.textStream ? { textStream: (request: TextRequest) => recordStream(provider.textStream!(request), (chunks, outcome) => record('textStream', provider, request, outcome, chunks)) } : {}),
        ...(provider.objectStream ? { objectStream: <T extends JsonValue>(request: ObjectRequest<T>) => recordStream(provider.objectStream!(request), (chunks, outcome) => record('objectStream', provider, request, outcome, chunks)) } : {})
      }
    },
    fixture(id) {
      return Object.freeze({ version: 1 as const, id, interactions: Object.freeze(interactions.map((entry) => Object.freeze({ ...entry }))) })
    }
  }
}

async function* recordStream<T>(source: AsyncIterable<T>, finish: (chunks: readonly T[], outcome: T) => void): AsyncIterable<T> {
  const chunks: T[] = []
  let last: T | undefined
  for await (const chunk of source) { chunks.push(chunk); last = chunk; yield chunk }
  if (last !== undefined) finish(chunks, last)
}

const replayStates = new WeakMap<ModelProvider, { fixture: SanitizedReplayFixture; cursor: number }>()

export function replayModelProvider(fixture: SanitizedReplayFixture, options: ReplayModelProviderOptions = {}): ModelProvider {
  if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.interactions)) {
    throw new ReplayFixtureError('Replay fixture is invalid.', { fixtureId: fixture?.id ?? 'unknown', reason: 'invalid_fixture' })
  }
  const state = { fixture, cursor: 0 }
  const consume = <T extends JsonValue>(method: ReplayMethod, request: { model: string }): SanitizedReplayInteraction => {
    const interaction = fixture.interactions[state.cursor]
    if (!interaction) throw new ReplayFixtureError('Replay fixture is exhausted.', { fixtureId: fixture.id, ordinal: state.cursor, reason: 'exhausted' })
    if (interaction.method !== method || interaction.request.fingerprint !== fingerprint(method, request)) {
      throw new ReplayFixtureError('Replay interaction does not match the request.', { fixtureId: fixture.id, ordinal: state.cursor, reason: 'mismatch' })
    }
    state.cursor += 1
    return interaction
  }
  const provider: ModelProvider = {
    id: options.id ?? 'replay', genAiSystem: options.genAiSystem ?? 'replay',
    text: async (request) => consume('text', request).outcome as unknown as TextResponse,
    object: async <T extends JsonValue>(request: ObjectRequest<T>) => consume<T>('object', request).outcome as unknown as ObjectResponse<T>,
    textStream: (request) => replayStream<TextStreamChunk>(consume('textStream', request)),
    objectStream: <T extends JsonValue>(request: ObjectRequest<T>) => replayStream<ObjectStreamChunk<T>>(consume<T>('objectStream', request))
  }
  replayStates.set(provider, state)
  return provider
}

async function* replayStream<T>(interaction: SanitizedReplayInteraction): AsyncIterable<T> {
  for (const chunk of interaction.chunks ?? []) yield chunk as T
}

export function assertReplayConsumed(provider: ModelProvider): void {
  const state = replayStates.get(provider)
  if (!state) throw new TypeError('Provider is not a replay provider.')
  if (state.cursor !== state.fixture.interactions.length) {
    throw new ReplayFixtureError('Replay fixture has unused interactions.', { fixtureId: state.fixture.id, ordinal: state.cursor, reason: 'unused' })
  }
}
