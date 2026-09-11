import { defineAgent, defineHarness, type ModelProvider } from '@purista/harness'
import { inspectAgentPlugin, loadAgentPlugins } from '@purista/harness-agent-plugins'
import { z } from 'zod'

/**
 * Review an already-installed plugin, pin its digest in application-owned
 * configuration, then explicitly choose its Skills and MCP tools.
 */
export async function reviewAndBindPlugin(root: string) {
  const inspection = await inspectAgentPlugin({ root })
  if (!inspection.valid || !inspection.digest) {
    throw new Error(`Plugin is not valid: ${inspection.diagnostics.map((item) => item.code).join(', ')}`)
  }

  // Persist this value in a reviewed lockfile in a real application.
  const expectedDigest = inspection.digest
  const [plugin] = await loadAgentPlugins({
    plugins: [{ root, trust: 'trusted', expectedDigest }]
  })
  if (!plugin) throw new Error('The reviewed plugin was not loadable.')

  return plugin.bindings({
    skills: { playbook: { runtimes: [] } },
    mcpServers: {
      pluginDocs: {
        server: 'docs',
        tools: {
          searchPluginDocs: {
            remoteName: 'search',
            description: 'Search the reviewed plugin documentation.',
            input: z.object({ query: z.string() }),
            output: z.object({ matches: z.array(z.string()) }),
          },
        },
        headers: { 'x-tenant': 'example' },
      }
    }
  })
}

/** Creates a typed Harness from the explicitly selected plugin projection. */
export async function createPluginHarness(root: string, provider: ModelProvider) {
  const bindings = await reviewAndBindPlugin(root)
  const researcher = defineAgent('researcher', {
    model: 'chat',
    instructions: 'Use the approved research resources when relevant.',
    tools: [bindings.mcpServers.pluginDocs.tools.searchPluginDocs],
    skills: [bindings.skills.playbook],
  })
  return defineHarness({ name: 'agentPluginExample' }).addAgent(researcher).getInstance({
    models: { chat: { provider, model: 'provider-model' } },
    mcp: bindings.mcp,
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2]
  if (!root) throw new Error('Usage: npm run start -- ./path/to/installed-plugin [./plugin-data]')
  reviewAndBindPlugin(root).then((bindings) => {
    console.log(JSON.stringify({ provenance: bindings.provenance }, null, 2))
  })
}
