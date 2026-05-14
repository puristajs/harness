# Sandbox

## Contents
- Mental Model
- Built-In Sandboxes
- SandboxSession API
- Exec Options And Results
- Skills And Memory Mounts
- Built-In Tools And Risk
- Custom Sandbox Adapters
- Snapshot And Resume Capabilities
- Testing

## Mental Model
The sandbox is the per-session filesystem and optional command-execution boundary. Agents and TypeScript tools interact with it through `SandboxSession`; MCP stdio also runs through the sandbox executor.

Keep sandbox policy explicit. Do not treat host filesystem, process execution, network policy, or secrets as implicitly safe.

## Built-In Sandboxes
```ts
import { autoDetectSandbox, bashSandbox, inMemorySandbox } from '@purista/harness'

defineHarness().sandbox(inMemorySandbox())
defineHarness().sandbox(bashSandbox({
  network: { deny: ['169.254.169.254'] },
  executionLimits: { wallClockMs: 120_000, memoryMb: 512 },
  python: true
}))
defineHarness().sandbox() // auto-detect bashSandbox(), fallback to inMemorySandbox()
```

`inMemorySandbox()`:
- capabilities: `['sandbox.fs']`
- filesystem-only
- `executor: 'unavailable'`
- `bash` and stdio MCP cannot run

`bashSandbox()`:
- capabilities: `['sandbox.fs', 'sandbox.exec']`
- requires optional peer dependency `just-bash`
- creates an in-memory filesystem session with command execution delegated to `just-bash`
- throws `HarnessConfigError` if `just-bash` is missing or has no exec surface

## SandboxSession API
Every sandbox session supports:

```ts
read(path): Promise<Uint8Array>
readText(path, 'utf-8'?): Promise<string>
write(path, Uint8Array | string): Promise<void>
remove(path, { recursive }?): Promise<void>
list(path, { recursive, glob }?): Promise<DirEntry[]>
stat(path): Promise<FileStat>
exists(path): Promise<boolean>
mount(files, atPath): Promise<void>
close(): Promise<void>
executor: 'available' | 'unavailable'
```

Paths must be absolute POSIX paths. Invalid paths throw `SandboxError` with `reason: 'invalid_path'`.

## Exec Options And Results
Exec-capable sessions expose:

```ts
exec(command, {
  cwd,
  env,
  stdin,
  timeoutMs,
  signal
}): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  durationSeconds: number
}>
```

Timeouts throw `OperationTimeoutError` with `scope: 'sandbox_run'`. Aborts throw `OperationCancelledError` with `scope: 'sandbox'`.

## Skills And Memory Mounts
The harness uses the sandbox for two important runtime paths:
- mounted skills: `/skills/<name>/...`
- default `sandboxMemory()` files: `/memory/session/<key>.json` and `/memory/runs/<runId>/<key>.json`

If an agent needs mounted skill instructions, leave read-only built-ins available:

```ts
builtinTools: ['read', 'list', 'grep']
```

If `builtinTools: false`, the model cannot inspect `/skills/<name>/SKILL.md` unless your own tool or prompt provides the content.

## Built-In Tools And Risk
Built-ins operate against the active sandbox:
- `read`, `list`, `glob`, `grep`: read-only
- `write`, `edit`: mutate sandbox files
- `bash`: executes commands when executor is available

Security defaults:
- use `inMemorySandbox()` for file-only agents
- disable all built-ins for tool-only agents with `builtinTools: false`
- enable only read-only built-ins for skill-reading agents
- add permission policies for `bash`, `write`, and `edit`
- use `bashSandbox()` only for workloads that genuinely need command execution or `mcp_stdio`

## Custom Sandbox Adapters
Implement `Sandbox<C>`:

```ts
const remoteSandbox = {
  capabilities: ['sandbox.fs', 'sandbox.exec'] as const,
  configureHarnessContext(context) {
    this.logger = context.logger
    this.telemetry = context.telemetry
  },
  async open({ sessionId, runId, signal }) {
    return remoteSession
  }
}
```

Adapter capabilities include:
- `sandbox.fs`
- `sandbox.exec`
- `sandbox.persistent_fs`
- `sandbox.snapshot`
- `sandbox.resume`
- `sandbox.hibernate`

Use `.requires([...])` to force startup failure when a required capability is absent.

## Snapshot And Resume Capabilities
Snapshot-capable adapters may implement:

```ts
snapshot(session): Promise<{ snapshotId: string, metadata?: Record<string, unknown> }>
resume({ snapshotId, sessionId, runId, signal }): Promise<SandboxSession>
hibernate(session): Promise<{ snapshotId: string, metadata?: Record<string, unknown> }>
```

Declare matching capabilities so orchestrators and durable runtimes can make safe decisions.

## Testing
Use `sandboxContract` and `sandboxSnapshotContract` from `@purista/harness/testing` for adapter behavior. Cover filesystem semantics, executor unavailable behavior, timeouts, cancellation, mount behavior, and close idempotency.
