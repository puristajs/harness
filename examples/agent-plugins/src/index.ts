import { inspectAgentPlugin, loadAgentPlugins } from '@purista/harness-agent-plugins'

/**
 * Review an already-installed plugin, pin its digest in application-owned
 * configuration, then explicitly choose its Skills and MCP tools.
 */
export async function reviewAndBindPlugin(root: string, dataDirectory?: string) {
  const inspection = await inspectAgentPlugin({ root })
  if (!inspection.valid || !inspection.digest) {
    throw new Error(`Plugin is not valid: ${inspection.diagnostics.map((item) => item.code).join(', ')}`)
  }

  // Persist this value in a reviewed lockfile in a real application.
  const expectedDigest = inspection.digest
  const [plugin] = await loadAgentPlugins({
    plugins: [{ root, trust: 'trusted', expectedDigest, ...(dataDirectory ? { dataDirectory } : {}) }]
  })
  if (!plugin) throw new Error('The reviewed plugin was not loadable.')

  return plugin.bindings({
    skills: { 'plugin-playbook': 'playbook' },
    tools: {
      search_plugin_docs: {
        server: 'docs',
        tool: 'search',
        description: 'Search the reviewed plugin documentation.',
        // Application-owned headers are intentional and redirect-safe.
        headers: { 'x-tenant': 'example' }
      }
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2]
  if (!root) throw new Error('Usage: npm run start -- ./path/to/installed-plugin [./plugin-data]')
  reviewAndBindPlugin(root, process.argv[3]).then((bindings) => {
    console.log(JSON.stringify({ diagnostics: bindings.diagnostics, provenance: bindings.provenance }, null, 2))
  })
}
