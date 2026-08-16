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
