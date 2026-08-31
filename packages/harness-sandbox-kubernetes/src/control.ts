import { createHash } from 'node:crypto'

import {
  OperationCancelledError,
  SandboxConflictError,
  type HarnessIdentity,
  type SandboxOwner,
  type SandboxScope,
} from '@purista/harness'
import type { KubernetesSandboxDriver, VersionedKubernetesRecord } from './driver.js'

export interface KubernetesOwnerRecord {
  readonly kind: 'owner'
  readonly owner: SandboxOwner
  readonly createdAt: string
  readonly updatedAt: string
  readonly revokedActors: readonly string[]
}

export interface KubernetesSandboxRecord {
  readonly kind: 'sandbox'
  readonly scope: SandboxScope
  readonly state: 'provisioning' | 'active' | 'state_lost' | 'terminated'
  readonly generation: number
  readonly podName?: string
  readonly volumeName?: string
  readonly workspaceRef?: string
  readonly ownsVolume: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly revokedActors: readonly string[]
}

export interface KubernetesWorkspaceBinding {
  readonly workspaceRef: string
  readonly volumeName: string
  readonly restoreReady: boolean
}

export interface KubernetesWorkspaceCoordinator {
  bindingForScope(scope: SandboxScope): Promise<KubernetesWorkspaceBinding | undefined>
}

export function ownerLogicalKey(owner: SandboxOwner): string {
  return JSON.stringify([
    owner.namespace,
    owner.id,
    owner.instanceId,
    owner.identity !== undefined,
    owner.identity?.tenantId ?? null,
    owner.identity?.principalId ?? null,
  ])
}

export function actorLogicalKey(identity: HarnessIdentity | undefined): string {
  return JSON.stringify([
    identity !== undefined,
    identity?.tenantId ?? null,
    identity?.principalId ?? null,
  ])
}

export function controlRecordName(prefix: string, logicalKey: string): string {
  return `${prefix}-${createHash('sha256').update(logicalKey).digest('hex').slice(0, 40)}`
}

export async function mutateRecord<T>(
  driver: KubernetesSandboxDriver,
  name: string,
  kind: string,
  operation: (current: T) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<VersionedKubernetesRecord<T>> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    throwIfAborted(signal)
    const current = await driver.readRecord<T>(name)
    if (!current) throw new SandboxConflictError('binding_changed')
    const next = await operation(current.value)
    if (await driver.replaceRecord(name, current.version, kind, next)) {
      const persisted = await driver.readRecord<T>(name)
      if (persisted) return persisted
    }
  }
  throw new SandboxConflictError('binding_changed')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError('Kubernetes sandbox operation was cancelled.', { scope: 'sandbox' })
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
