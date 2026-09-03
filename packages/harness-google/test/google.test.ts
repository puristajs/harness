import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'

import { google, type GoogleClient } from '../src/index.js'

function signal(): AbortSignal {
  return new AbortController().signal
}

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

describe('google provider factory', () => {
  it('constructs an official SDK client from Gemini API options without reading environment variables', () => {
    const provider = google({
      apiKey: 'test-key',
      httpOptions: { retryOptions: { attempts: 2 }, headers: { 'x-test': 'yes' } },
    })

    expect(provider).toMatchObject({ id: 'google', genAiSystem: 'google.gemini' })
  })

  it('maps text, token usage, and native finish reason', async () => {
    const provider = google({
      client: client({
        generateContent: async () => response('hello', 'STOP'),
      }),
    })

    expect(provider.id).toBe('google')
    expect(provider.genAiSystem).toBe('google.gemini')
    await expect(provider.text!({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], signal: signal() }))
      .resolves.toMatchObject({
        content: 'hello',
        finishReason: 'stop',
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1, reasoningTokens: 1 },
      })
  })

  it('maps application tools, tool result history, and tool calls', async () => {
    const requests: any[] = []
    const provider = google({
      client: client({
        generateContent: async (request) => {
          requests.push(request)
          return {
            candidates: [{
              content: { parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { id: 'T-1' } } }] },
              finishReason: 'STOP',
            }],
          }
        },
      }),
    })

    const result = await provider.text!({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'Be accurate.' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'previous', name: 'lookup', arguments: { id: 'T-0' } }] },
        { role: 'tool', toolCallId: 'previous', content: '{"status":"open"}' },
        { role: 'user', content: [{ kind: 'text', text: 'Find T-1' }, { kind: 'image', mimeType: 'image/png', dataBase64: 'AA==' }] },
      ],
      tools: [{ name: 'lookup', description: 'Look up a ticket.', parameters: schema }],
      signal: signal(),
    })

    expect(result).toMatchObject({ finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { id: 'T-1' } }] })
    expect(requests[0]).toMatchObject({
      config: {
        systemInstruction: 'Be accurate.',
        tools: [{ functionDeclarations: [{ name: 'lookup', parametersJsonSchema: schema }] }],
      },
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'previous', name: 'lookup', args: { id: 'T-0' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'previous', name: 'lookup', response: { output: '{"status":"open"}' } } }] },
        { role: 'user', parts: [{ text: 'Find T-1' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
      ],
    })
  })

  it('maps every supported Harness content part without uploading it', async () => {
    const requests: any[] = []
    const provider = google({
      client: client({
        generateContent: async (request) => {
          requests.push(request)
          return response('ok', 'STOP')
        },
      }),
    })

    await provider.text!({
      model: 'gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { kind: 'text', text: 'Inspect.' },
          { kind: 'audio', mimeType: 'audio/mpeg', dataBase64: 'AQ==' },
          { kind: 'file', mimeType: 'application/pdf', dataBase64: 'Ag==' },
          { kind: 'image_url', url: 'gs://bucket/image.png', mimeType: 'image/png' },
          { kind: 'image_url', url: 'gs://bucket/unknown-type' },
          { kind: 'file_url', url: 'gs://bucket/report.pdf', mimeType: 'application/pdf', filename: 'report.pdf' },
        ],
      }],
      signal: signal(),
    })

    expect(requests[0].contents[0].parts).toEqual([
      { text: 'Inspect.' },
      { inlineData: { mimeType: 'audio/mpeg', data: 'AQ==' } },
      { inlineData: { mimeType: 'application/pdf', data: 'Ag==' } },
      { fileData: { fileUri: 'gs://bucket/image.png', mimeType: 'image/png' } },
      { fileData: { fileUri: 'gs://bucket/unknown-type' } },
      { fileData: { fileUri: 'gs://bucket/report.pdf', mimeType: 'application/pdf' } },
    ])
  })

  it('uses a safe placeholder when a persisted tool result has no matching call name', async () => {
    const requests: any[] = []
    const provider = google({
      client: client({
        generateContent: async (request) => {
          requests.push(request)
          return response('ok', 'STOP')
        },
      }),
    })

    await provider.text!({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'tool', toolCallId: 'missing', content: '{"ok":true}' }],
      signal: signal(),
    })

    expect(requests[0].contents[0]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'missing', name: 'harness_tool', response: { output: '{"ok":true}' } } }],
    })
  })

  it('creates a deterministic tool-call id when Gemini does not return one', async () => {
    const provider = google({
      client: client({
        generateContent: async () => ({
          candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { id: 'T-3' } } }] } }],
        }),
      }),
    })

    await expect(provider.text!({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Lookup.' }], signal: signal() }))
      .resolves.toMatchObject({ toolCalls: [{ id: 'google_text_0', name: 'lookup', arguments: { id: 'T-3' } }] })
  })

  it('preserves compiled JSON Schema for structured output and parses the response', async () => {
    const requests: any[] = []
    const provider = google({
      client: client({
        generateContent: async (request) => {
          requests.push(request)
          return response('{"answer":"yes"}', 'STOP')
        },
      }),
    })

    const result = await provider.object!({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Answer.' }],
      schema,
      signal: signal(),
    })

    expect(result.object).toEqual({ answer: 'yes' })
    expect(requests[0].config).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: schema })
    expect(requests[0].config.responseJsonSchema).toBe(schema)
  })

  it('maps stream deltas, trailing function calls, and final usage', async () => {
    async function* stream() {
      yield { candidates: [{ content: { parts: [{ text: '{"answer":' }] } }] }
      yield { candidates: [{ content: { parts: [{ text: '"yes"}' }, { functionCall: { id: 'call_2', name: 'lookup', args: { id: 'T-2' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, responseTokenCount: 2, totalTokenCount: 5 } }
    }
    const provider = google({ client: client({ generateContentStream: async () => stream() }) })
    const chunks: any[] = []
    for await (const chunk of provider.objectStream!({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Answer.' }], schema, signal: signal() })) chunks.push(chunk)

    expect(chunks).toContainEqual({ kind: 'tool_call', call: { id: 'call_2', name: 'lookup', arguments: { id: 'T-2' } } })
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', object: { answer: 'yes' }, finishReason: 'tool_calls', usage: { totalTokens: 5 } })
  })

  it('maps embeddings and requested dimensions', async () => {
    const requests: any[] = []
    const provider = google({
      client: client({
        embedContent: async (request) => {
          requests.push(request)
          return { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }
        },
      }),
    })

    const result = await provider.embed!({ model: 'gemini-embedding-2', input: ['one', 'two'], dimensions: 2, signal: signal() })
    expect(result.embeddings).toEqual([{ index: 0, vector: [0.1, 0.2] }, { index: 1, vector: [0.3, 0.4] }])
    expect(requests[0]).toMatchObject({ model: 'gemini-embedding-2', contents: ['one', 'two'], config: { outputDimensionality: 2 } })
  })

  it('normalizes malformed structured output through the base provider', async () => {
    const provider = google({ client: client({ generateContent: async () => response('{', 'STOP') }) })
    await expect(provider.object!({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Answer.' }], schema, signal: signal() }))
      .rejects.toBeInstanceOf(ModelError)
  })

  it('normalizes Gemini length, content filter, malformed tool, and unknown finish reasons', async () => {
    for (const [reason, expected] of [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['MALFORMED_FUNCTION_CALL', 'malformed'],
      ['UNEXPECTED_TOOL_CALL', 'malformed'],
      ['OTHER', 'error'],
    ] as const) {
      const provider = google({ client: client({ generateContent: async () => response('status', reason) }) })
      await expect(provider.text!({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Status.' }], signal: signal() }))
        .resolves.toMatchObject({ finishReason: expected, outcome: { providerFinishReason: reason } })
    }
  })
})

function client(overrides: Partial<GoogleClient['models']>): GoogleClient {
  return {
    models: {
      generateContent: async () => response('ok', 'STOP'),
      generateContentStream: async () => emptyStream(),
      embedContent: async () => ({ embeddings: [] }),
      ...overrides,
    },
  }
}

async function* emptyStream() {
  yield response('ok', 'STOP')
}

function response(text: string, finishReason: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 4, responseTokenCount: 2, totalTokenCount: 6, cachedContentTokenCount: 1, thoughtsTokenCount: 1 },
  }
}
