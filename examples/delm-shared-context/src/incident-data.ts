import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskEvidencePacketSchema, type TaskEvidencePacket } from './schemas.js'

const here = dirname(fileURLToPath(import.meta.url))
const exampleRoot = join(here, '..')
const dataRoots = [
  join(process.cwd(), 'data'),
  join(process.cwd(), 'examples/delm-shared-context/data'),
  join(exampleRoot, 'data')
]
const dataFiles = ['logs.json', 'metrics.json', 'runbook.json', 'reproductions.json'] as const

export const checkoutIncidentEvidence: Record<string, TaskEvidencePacket> = Object.fromEntries(
  dataFiles.map((file) => {
    const packet = taskEvidencePacketSchema.parse(JSON.parse(readFileSync(resolveDataFile(file), 'utf8')))
    return [packet.taskId, packet]
  })
)

export function evidenceForTask(taskId: string): TaskEvidencePacket {
  const packet = checkoutIncidentEvidence[taskId]
  if (!packet) {
    throw new Error(`No checkout incident evidence packet configured for task ${taskId}`)
  }
  return packet
}

function resolveDataFile(file: string): string {
  for (const root of dataRoots) {
    const candidate = join(root, file)
    if (existsSync(candidate)) return candidate
  }
  return join(dataRoots.at(-1) ?? '.', file)
}
