import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	createVerificationLayout,
	npmVerificationArguments,
	requireOfflineCache,
	runCheckedCommand,
	withVerificationScratch,
} from './check-purista-sandbox.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function packPackages(destination, layout) {
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build', '--workspace', '@purista/harness', '--workspace', '@purista/harness-sandbox-docker']), { cwd: root })
	const packed = JSON.parse(runCheckedCommand('npm', npmVerificationArguments(layout, 'pack', [
		'--workspace', '@purista/harness', '--workspace', '@purista/harness-sandbox-docker',
		'--ignore-scripts', '--json', '--pack-destination', destination,
	]), { cwd: root, captureOutput: true }))
	if (!Array.isArray(packed) || packed.length !== 2 || packed.some(item => typeof item?.name !== 'string' || typeof item?.filename !== 'string')) {
		throw new Error('Packing Harness sandbox packages did not produce both local tarballs.')
	}
	return packed
}

async function main() {
	const layout = createVerificationLayout(root)
	await requireOfflineCache(layout.cache)
	await withVerificationScratch(layout, async scratchDirectory => {
		const tarballs = join(scratchDirectory, 'tarballs')
		const consumer = join(scratchDirectory, 'consumer')
		await mkdir(tarballs)
		await mkdir(consumer)
		const packed = await packPackages(tarballs, layout)
		const harness = JSON.parse(await readFile(join(root, 'packages/harness/package.json'), 'utf8'))
		await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
			name: 'sandbox-package-consumer-check', private: true, type: 'module',
			dependencies: Object.fromEntries(packed.map(item => [item.name, `file:${relative(consumer, join(tarballs, item.filename))}`])),
			devDependencies: { '@types/node': harness.devDependencies['@types/node'] },
		}, null, 2)}\n`)
		await writeFile(join(consumer, 'tsconfig.json'), `${JSON.stringify({
			compilerOptions: {
				target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
				exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noEmit: true,
				skipLibCheck: false, types: ['node'],
			},
			include: ['consumer.ts'],
		}, null, 2)}\n`)
		await copyFile(join(root, 'scripts/fixtures/sandbox-package-consumer.ts'), join(consumer, 'consumer.ts'))
		runCheckedCommand('npm', npmVerificationArguments(layout, 'install', ['--ignore-scripts', '--no-audit', '--no-fund']), { cwd: consumer })
		const compilerRoot = join(root, 'node_modules/typescript')
		const compiler = JSON.parse(await readFile(join(compilerRoot, 'package.json'), 'utf8'))
		runCheckedCommand(process.execPath, [join(compilerRoot, compiler.bin.tsc), '-p', 'tsconfig.json'], { cwd: consumer })
		runCheckedCommand(process.execPath, ['consumer.ts'], { cwd: consumer })
	})
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : 'Sandbox package verification failed.')
	process.exitCode = 1
})
