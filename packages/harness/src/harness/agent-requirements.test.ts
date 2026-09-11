import { describe, expect, it } from 'vitest'

import { compileAgentExecutionRequirements } from './agent-requirements.js'

describe('compiled agent execution requirements', () => {
  it('merges direct declarations deterministically without weakening their provenance', () => {
    expect(compileAgentExecutionRequirements([
      { path: 'interceptors.first', requirements: { tools: ['search', 'search'], models: [{ alias: 'chat', capabilities: ['text', 'tool_use'] }] } },
      { path: 'interceptors.second', requirements: { tools: ['write', 'search'], models: [{ alias: 'chat', capabilities: ['tool_use', 'object'] }, { alias: 'reviewer', capabilities: ['text'] }] } },
      { path: 'interceptors.empty', requirements: {} }
    ])).toEqual({
      tools: [{ id: 'search', path: 'interceptors.first' }, { id: 'write', path: 'interceptors.second' }],
      models: [
        { alias: 'chat', path: 'interceptors.first', capabilities: [
          { capability: 'text', path: 'interceptors.first' },
          { capability: 'tool_use', path: 'interceptors.first' },
          { capability: 'object', path: 'interceptors.second' }
        ] },
        { alias: 'reviewer', path: 'interceptors.second', capabilities: [{ capability: 'text', path: 'interceptors.second' }] }
      ]
    })
  })
})
