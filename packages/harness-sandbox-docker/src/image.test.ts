import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const enabled = process.env['PURISTA_DOCKER_SANDBOX_TEST'] === '1'

describe.runIf(enabled)('minimal sandbox image', () => {
  it.each(['1000:1000', '65532:65532'])('runs the guest contract with restricted UID/GID %s', user => {
    const image = process.env['PURISTA_DOCKER_SANDBOX_IMAGE']
    if (!image || !/^(?:[^\s\0]+@)?sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('Set PURISTA_DOCKER_SANDBOX_IMAGE to the already-built immutable image ID or digest.')
    }
    const context = process.env['PURISTA_DOCKER_SANDBOX_CONTEXT']
    const prefix = context ? ['--context', context] : []
    const name = `purista-image-smoke-${randomUUID()}`
    const [uid, gid] = user.split(':')
    try {
      const result = spawnSync('docker', [...prefix, 'run', '--rm', '--pull=never', '--name', name,
        '--read-only', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--pids-limit=64', '--memory=256m', '--cpus=1', '--user', user,
        ...['/workspace', '/skills', '/tmp'].flatMap(path => ['--tmpfs', `${path}:rw,noexec,nosuid,nodev,size=16m,uid=${uid},gid=${gid},mode=0700`]),
        '-i', image, 'sh', '-s'], {
        input: readFileSync(new URL('../image/smoke.sh', import.meta.url)),
        encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Sandbox image smoke passed')
    } finally {
      // Only this test's exact named container; also handles a killed CLI.
      const cleanup = spawnSync('docker', [...prefix, 'rm', '-f', name], { encoding: 'utf8', timeout: 10_000 })
      if (cleanup.error || (cleanup.status !== 0 && !cleanup.stderr.includes('No such container'))) {
        throw new Error(`Image smoke cleanup failed for ${name}; inspect and remove that exact test container.`)
      }
    }
  }, 45_000)
})
