import { resolve } from 'node:path'
import type { StateStore } from '../ports/state.js'
import type { DurableRuntime } from '../runtime/durable.js'
import type { DurableWorkspacePolicy, DurableWorkspaceStore } from '../ports/workspace.js'
import type { ContextCheckpointStore } from '../ports/context-checkpoints.js'
import type { DurableExternalWaitAdapter } from '../ports/external-wait.js'
import { createLocalWorkspaceCoordinator, localDirectoryWorkspaceStore } from './local-workspace.js'
import { localDirectorySandbox, type LocalDurableSandbox, type LocalHostExecPolicy } from './local-sandbox.js'
import { SqliteHarnessStorage, type SqliteDurableRuntimeOptions, type SqliteContextCheckpointStoreOptions, type SqliteStateStoreOptions, sqliteContextCheckpointStore, sqliteDurableRuntime, sqliteStateStore } from './sqlite-storage.js'

export type {
  LocalHostExecPolicy,
  LocalDirectorySandboxOptions,
  LocalDurableSandbox,
  LocalFilesOnlySandboxCapabilities,
  LocalExecSandboxCapabilities
} from './local-sandbox.js'
export type { LocalDirectoryWorkspaceStoreOptions } from './local-workspace.js'
export type { SqliteDurableRuntimeOptions, SqliteContextCheckpointStoreOptions, SqliteStateStoreOptions } from './sqlite-storage.js'
export { localDirectorySandbox } from './local-sandbox.js'
export { localDirectoryWorkspaceStore } from './local-workspace.js'
export { sqliteContextCheckpointStore, sqliteDurableRuntime, sqliteStateStore, SqliteHarnessStorage } from './sqlite-storage.js'

export interface LocalDurableExecutionOptions {
  /** Host directory used for SQLite files, active workspaces, and snapshots. */
  root: string
  /** SQLite database file. Default: `${root}/runtime.sqlite`. */
  databaseFile?: string
  /** Stable worker id reserved for future policies. */
  workerId?: string
  /** Host command execution policy. Default: `false`. */
  exec?: false | LocalHostExecPolicy
  /** Workspace retention/quota/encryption metadata reported by the store. */
  policy?: Partial<DurableWorkspacePolicy>
  /** Lease takeover window for crashed workers. Default: `120_000`. */
  leaseTtlMs?: number
}

export interface LocalDurableExecution {
  state: StateStore
  runtime: DurableRuntime
  /** Files-only by default; advertises `sandbox.exec` only when `exec` is configured (spec 22 §2). */
  sandbox: LocalDurableSandbox
  workspaceStore: DurableWorkspaceStore
  checkpoints: ContextCheckpointStore
  /** Durable, SQLite-backed opaque wait/signal persistence. */
  externalWait: DurableExternalWaitAdapter
  close(): Promise<void>
}

/** Creates the recommended local durable adapter bundle for single-host usage. */
export function localDurableExecution(options: LocalDurableExecutionOptions): LocalDurableExecution {
  const root = resolve(options.root)
  const coordinator = createLocalWorkspaceCoordinator()
  const storage = new SqliteHarnessStorage({
    file: options.databaseFile ?? resolve(root, 'runtime.sqlite'),
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {})
  })
  return {
    state: storage,
    runtime: storage,
    checkpoints: storage,
    externalWait: storage,
    sandbox: localDirectorySandbox({ root, exec: options.exec ?? false, coordinator }),
    workspaceStore: localDirectoryWorkspaceStore({ root, ...(options.policy ? { policy: options.policy } : {}), coordinator }),
    close: () => storage.close()
  }
}
