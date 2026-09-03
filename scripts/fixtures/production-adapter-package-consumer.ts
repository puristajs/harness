import assert from 'node:assert/strict'
import type { DurableWorkspace, HarnessStorage, Sandbox } from '@purista/harness'
import {
	kubernetesSandboxRuntime,
	type KubernetesSandboxDriver,
} from '@purista/harness-sandbox-kubernetes'
import { postgresHarnessStorage } from '@purista/harness-storage-postgres'

assert.throws(
	() => kubernetesSandboxRuntime({ namespace: '', image: 'sandbox:test' }),
	(error: unknown) =>
		typeof error === 'object'
		&& error !== null
		&& 'meta' in error
		&& (error as { meta?: { path?: string } }).meta?.path === 'options.namespace',
)
assert.throws(() => postgresHarnessStorage({}), /exactly one/)
assert.throws(() => import.meta.resolve('@purista/core'), { code: 'ERR_MODULE_NOT_FOUND' })
assert.throws(
	() => import.meta.resolve('@purista/harness-sandbox-kubernetes/dist/runtime.js'),
	{ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
)
assert.throws(
	() => import.meta.resolve('@purista/harness-storage-postgres/dist/index.js'),
	{ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
)

// Checked against the packed declarations. The driver is intentionally not
// executed; platform wrappers can inject it without importing internals.
function checkPublicTypes(driver: KubernetesSandboxDriver): void {
	const execution = kubernetesSandboxRuntime({
		namespace: 'consumer',
		image: 'sandbox:test',
		runtimeId: 'consumer-v1',
		driver,
		workspace: true,
	})
	const sandbox: Sandbox = execution.sandbox
	const workspace: DurableWorkspace = execution.workspace
	const storage: HarnessStorage = postgresHarnessStorage({ connectionString: 'postgresql://localhost/test' })
	void sandbox
	void workspace
	void storage
}
void checkPublicTypes

console.log('Packed PostgreSQL and Kubernetes adapters: declarations and public boundaries passed.')
