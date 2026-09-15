import { serve } from '@hono/node-server'
import { createLivingWikiApi } from './backend/app.js'
import { loadRootEnv } from './backend/harness.js'
import { startOpenTelemetry } from './backend/telemetry.js'

loadRootEnv()
const telemetry = startOpenTelemetry()
const { app, shutdown } = await createLivingWikiApi()
const port = Number(process.env['PORT'] ?? 8787)

const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`living wiki API listening on http://${info.address}:${info.port}`)
})

async function stop() {
  server.close()
  await shutdown()
  await telemetry.shutdown().catch(() => undefined)
}

process.on('SIGINT', () => { void stop().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)) })
