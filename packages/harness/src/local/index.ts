import { resolve } from 'node:path'
import type { DurableWorkspacePolicy, DurableWorkspace } from '../ports/workspace.js'
import type { HarnessStorage } from '../storage/types.js'
import { createLocalWorkspaceCoordinator, localDirectoryWorkspace } from './local-workspace.js'
import { localDirectorySandbox, type LocalDurableSandbox, type LocalHostExecPolicy } from './local-sandbox.js'
import { SqliteHarnessStorage, type SqliteHarnessStorageOptions, sqliteHarnessStorage } from '../storage/sqlite.js'

export type {
  LocalHostExecPolicy,
  LocalDirectorySandboxOptions,
  LocalDurableSandbox,
  LocalFilesOnlySandboxCapabilities,
  LocalExecSandboxCapabilities
} from './local-sandbox.js'
export type { LocalDirectoryWorkspaceOptions } from './local-workspace.js'
export type { SqliteHarnessStorageOptions } from '../storage/sqlite.js'
export { localDirectorySandbox } from './local-sandbox.js'
export { LocalDirectoryWorkspace, localDirectoryWorkspace } from './local-workspace.js'
export { sqliteHarnessStorage, SqliteHarnessStorage } from '../storage/sqlite.js'

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
  storage: HarnessStorage
  /** Files-only by default; advertises `sandbox.exec` only when `exec` is configured (spec 22 §2). */
  sandbox: LocalDurableSandbox
  workspace: DurableWorkspace
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
    storage,
    sandbox: localDirectorySandbox({ root, exec: options.exec ?? false, coordinator }),
    workspace: localDirectoryWorkspace({ root, ...(options.policy ? { policy: options.policy } : {}), coordinator }),
    close: () => storage.close()
  }
}
