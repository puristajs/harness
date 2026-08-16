import { expect, it } from 'vitest'
import { assertReplayConsumed, createReplayInteractionRecorder, replayModelProvider } from '../src/testing/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

it('records only sanitizer output and replays it without the source provider', async () => {
  const source = new FakeModelProvider()
  source.enqueueText({ content: 'secret output', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const recorder = createReplayInteractionRecorder({ sanitize: () => ({ redacted: true }) })
  const wrapped = recorder.wrap(source)
  await wrapped.text?.({ model: 'demo', messages: [{ role: 'user', content: 'secret input' }], signal: new AbortController().signal })
  const fixture = recorder.fixture('sanitized')
  expect(JSON.stringify(fixture)).not.toContain('secret')

  const replay = replayModelProvider(fixture)
  await replay.text?.({ model: 'demo', messages: [{ role: 'user', content: 'different content' }], signal: new AbortController().signal })
  expect(source.requests).toHaveLength(1)
  expect(() => assertReplayConsumed(replay)).not.toThrow()
})

it('fails strictly for an exhausted or unused fixture', async () => {
  const fixture = { version: 1 as const, id: 'strict', interactions: [] }
  const replay = replayModelProvider(fixture)
  await expect(replay.text?.({ model: 'demo', messages: [], signal: new AbortController().signal })).rejects.toMatchObject({ code: 'REPLAY_FIXTURE_ERROR' })
  expect(() => assertReplayConsumed(replay)).not.toThrow()
})

it('rejects malformed interactions as invalid fixtures before replay', () => {
  for (const fixture of [
    { version: 1, id: 'bad', interactions: [null] },
    { version: 1, id: 'bad', interactions: [{ method: 'text', request: null, outcome: null }] }
  ]) {
    try {
      replayModelProvider(fixture as never)
      throw new Error('Expected invalid replay fixture to throw.')
    } catch (error) {
      expect(error).toMatchObject({ code: 'REPLAY_FIXTURE_ERROR', meta: { reason: 'invalid_fixture', ordinal: 0 } })
    }
  }
})

it('rejects non-JSON sanitizer output while recording', async () => {
  const source = new FakeModelProvider()
  source.enqueueText({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const recorder = createReplayInteractionRecorder({ sanitize: () => undefined })
  const wrapped = recorder.wrap(source)
  await expect(wrapped.text?.({ model: 'demo', messages: [], signal: new AbortController().signal })).rejects.toMatchObject({
    code: 'REPLAY_FIXTURE_ERROR', meta: { fixtureId: 'recording', reason: 'invalid_fixture' }
  })
})
