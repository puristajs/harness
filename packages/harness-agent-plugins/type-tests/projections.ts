import { z } from 'zod'
import { defineAgent } from '@purista/harness'
import type { LoadedAgentPlugin } from '../src/index.js'

declare const plugin: LoadedAgentPlugin
const input = z.object({ query: z.string() })
const output = z.object({ answer: z.string() })
const bindings = plugin.bindings({
	skills: { research: { runtimes: ['python'] as const } },
	mcpServers: {
		knowledge: {
			server: 'remote',
			resolveHeaders: async ({ caller }) => caller.kind === 'agent' ? { authorization: 'agent' } : { authorization: 'workflow' },
			tools: { searchDocs: { remoteName: 'search_docs', description: 'Search documents.', input, output } },
		},
	},
})

const skillId: 'research' = bindings.skills.research.id
const runtime: 'python' = bindings.skills.research.runtimes[0]
const serverId: 'knowledge' = bindings.mcpServers.knowledge.id
const toolId: 'searchDocs' = bindings.mcpServers.knowledge.tools.searchDocs.id
const parsedInput: string = bindings.mcpServers.knowledge.tools.searchDocs.$infer.input.query
const parsedOutput: string = bindings.mcpServers.knowledge.tools.searchDocs.$infer.output.answer
const resolveHeaders = bindings.mcp.knowledge.resolveHeaders
void [skillId, runtime, serverId, toolId, parsedInput, parsedOutput, resolveHeaders]

defineAgent('researchAgent', {
	model: 'chat',
	instructions: 'Use the selected sources.',
	tools: [bindings.mcpServers.knowledge.tools.searchDocs],
	skills: [bindings.skills.research],
})

// @ts-expect-error Unselected keys do not appear in exact result maps.
bindings.skills.other
// @ts-expect-error Unselected MCP server keys do not appear in exact result maps.
bindings.mcpServers.other
// @ts-expect-error Unselected tool keys do not appear in exact result maps.
bindings.mcpServers.knowledge.tools.other
// @ts-expect-error Structurally forged values do not satisfy the Core definition brand.
defineAgent('forgedAgent', { model: 'chat', instructions: 'Invalid.', skills: [{ kind: 'skill', id: 'research', directory: new URL('file:///tmp/research') }] })
// @ts-expect-error Both selection maps are mandatory.
plugin.bindings({ skills: {} })
