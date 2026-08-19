import { cp, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'skills', 'ai-harness')
const args = process.argv.slice(2)
const check = args[0] === '--check'
const target = path.resolve(check ? args[1] ?? '' : args[0] ?? '')

if (!target || target === root || target === source) {
  throw new Error('Usage: npm run skills:sync -- [--check] <installed-ai-harness-skill-directory>')
}

if (check) {
  await assertEquivalent(source, target)
  process.stdout.write(`AI Harness skill mirror is current: ${target}\n`)
} else {
  await cp(source, target, { recursive: true, force: true })
  await assertEquivalent(source, target)
  process.stdout.write(`AI Harness skill mirror synchronized: ${target}\n`)
}

async function assertEquivalent(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listFiles(left), listFiles(right)])
  if (leftFiles.join('\n') !== rightFiles.join('\n')) {
    throw new Error('AI Harness skill mirror has a different file set.')
  }
  for (const file of leftFiles) {
    const [leftContents, rightContents] = await Promise.all([
      readFile(path.join(left, file)),
      readFile(path.join(right, file)),
    ])
    if (!leftContents.equals(rightContents)) {
      throw new Error(`AI Harness skill mirror differs: ${file}`)
    }
  }
}

async function listFiles(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, next)))
    } else if ((await stat(path.join(directory, next))).isFile()) {
      files.push(next)
    }
  }
  return files.sort()
}
