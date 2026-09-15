import { PassThrough } from 'node:stream'
import { compileSafeRegex } from '@purista/harness'
import type { DockerChild, DockerTransport } from './transport.js'

type Resource = { owner: string; running: boolean; files: Map<string, Buffer> }
export interface Script { stdout?: string | Uint8Array; stderr?: string; code?: number; hang?: boolean }

/** Protocol double, not an emulation or proof of Docker/kernel isolation. */
export class ScriptedDocker implements DockerTransport {
  public readonly calls: string[][] = []
  public readonly containers = new Map<string, Resource>()
  public readonly volumes = new Map<string, Resource>()
  public engine = 'test-engine'
  public host = 'unix:///test-docker.sock'
  public os = 'linux'
  public failure: ((args: readonly string[]) => Script | undefined) | undefined
  public readonly hanging = new Set<() => void>()
  public killedClients = 0
  public writes: string[] = []

  public async start(input: readonly string[]): Promise<DockerChild> {
    this.calls.push([...input])
    const args = input[0] === '--host' ? input.slice(2) : input
    const scripted = this.failure?.(args)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let finish!: (value: { exitCode: number; signal?: string }) => void
    const exit = new Promise<{ exitCode: number; signal?: string }>(resolve => { finish = resolve })
    let done = false
    const end = (result: Script) => {
      if (done) return
      done = true
      if (result.stdout) stdout.write(result.stdout)
      if (result.stderr) stderr.write(result.stderr)
      stdout.end(); stderr.end(); finish({ exitCode: result.code ?? 0 })
    }
    const complete = (stdin = '') => {
      const result = scripted ?? this.dispatch(args, stdin)
      if (result.hang) {
        if (result.stdout) stdout.write(result.stdout)
        this.hanging.add(() => end({ code: 137 }))
      } else queueMicrotask(() => end(result))
    }
    if (args[0] === 'exec' && args.includes('node')) complete()
    return {
      stdout, stderr, exit,
      write: async chunk => { this.writes.push(chunk) },
      end: complete,
      kill: () => { this.killedClients++; end({ code: 137 }) },
    }
  }
  private dispatch(args: readonly string[], stdin: string): Script {
    if (args[0] === 'context' && args[1] === 'show') return { stdout: 'local\n' }
    if (args[0] === 'context' && args[1] === 'inspect') return { stdout: this.host }
    if (args[0] === 'info') return { stdout: `${this.engine}\t${this.os}` }
    if (args[0] === 'image') return { stdout: this.os }
    if ((args[0] === 'container' || args[0] === 'volume') && args[1] === 'inspect') {
      const name = args.at(-1)!
      const value = (args[0] === 'container' ? this.containers : this.volumes).get(name)
      return value ? { stdout: `${name}\t${value.owner}${args[0] === 'container' ? `\t${value.running}` : ''}` } : { code: 1, stderr: `Error: No such ${args[0]}: private-name` }
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      this.volumes.set(args.at(-1)!, { owner: args[args.indexOf('--label') + 1]!.split('=')[1]!, running: false, files: new Map() })
      return { stdout: args.at(-1)! }
    }
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]!
      this.containers.set(name, { ...this.volumes.get(name)!, running: true })
      return { stdout: name }
    }
    if (args[0] === 'container' && args[1] === 'start') { this.containers.get(args.at(-1)!)!.running = true; return {} }
    if (args[0] === 'container' && (args[1] === 'stop' || args[1] === 'kill')) {
      this.containers.get(args.at(-1)!)!.running = false
      for (const finish of this.hanging) finish()
      this.hanging.clear()
      return {}
    }
    if (args[1] === 'rm') { (args[0] === 'container' ? this.containers : this.volumes).delete(args.at(-1)!); return {} }
    if (args[0] !== 'exec') throw new Error(`Unscripted Docker operation: ${args[0]}`)
    if (args.some(argument => argument.includes('for tool in'))) return {}
    const containerName = args.find(argument => argument.startsWith('purista_sb_'))!
    const container = this.containers.get(containerName)
    if (!container?.running) return { code: 1, stderr: 'Error: container is not running' }
    const files = container.files
    const script = args.find(argument => argument.startsWith('target=') && !argument.includes('exec "$@"'))
    const path = args.at(-1)!
    if (script?.includes('base64 -d')) { files.set(path, Buffer.from(stdin, 'base64')); return {} }
    if (script?.includes('base64 <')) { const bytes = files.get(path); return bytes ? { stdout: bytes.toString('base64') } : { code: 1 } }
    if (script?.includes('printf present')) return { stdout: files.has(path) ? 'present' : 'absent' }
    if (script?.includes('rm -')) { files.delete(path); return {} }
    if (script?.includes('find ')) return { stdout: [...files].filter(([name]) => name.startsWith(`${path}/`)).map(([name, data]) => `f\0${name}\0${data.length}\0`).join('') }
    if (script?.includes('stat --printf')) { const bytes = files.get(path); return bytes ? { stdout: ['file', String(bytes.length), '1777200000'].join('\0') } : { code: 1 } }
    const grepIndex = args.lastIndexOf('grep')
    if (grepIndex >= 0) {
      const separator = args.indexOf('--', grepIndex)
      const pattern = args[separator + 1]!
      const filePath = args[separator + 2]!
      const bytes = files.get(filePath)
      if (!bytes) return { code: 1 }
      const caseSensitive = !args.includes('-i')
      const literal = args.includes('-F')
      const limitIndex = args.indexOf('-m', grepIndex)
      const limit = Number(args[limitIndex + 1])
      const regex = literal ? undefined : compileSafeRegex(pattern)
      const needle = caseSensitive ? pattern : pattern.toLowerCase()
      const matched = bytes.toString('utf8').split('\n').flatMap((line, index) => {
        const found = regex ? regex.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(needle)
        return found ? [`${index + 1}:${line}`] : []
      }).slice(0, limit)
      return matched.length > 0 ? { stdout: `${matched.join('\n')}\n` } : { code: 1 }
    }
    const command = args.at(-1)!
    if (command === 'echo hi') return { stdout: 'hi\n' }
    if (command === 'sleep 1') return { hang: true }
    if (command.startsWith('printf "$GREETING:')) return { stdout: `${args.find(argument => argument.startsWith('GREETING='))?.slice('GREETING='.length) ?? ''}:${files.get('/workspace/cwd.txt')?.toString() ?? ''}:${stdin}` }
    if (command === 'node' || args.includes('node')) return { hang: true }
    return { stdout: 'scripted guest output', stderr: '', code: 0 }
  }
}
