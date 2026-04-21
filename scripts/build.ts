import { execSync } from 'node:child_process'
import { join } from 'node:path'

const rootDir = join(import.meta.dir, '..')
const distDir = join(rootDir, 'dist')

execSync('rm -rf dist', { cwd: rootDir, stdio: 'inherit' })
execSync('tsc --emitDeclarationOnly', { cwd: rootDir, stdio: 'inherit' })

const result = await Bun.build({
	entrypoints: [join(rootDir, 'src', 'index.ts')],
	outdir: distDir,
	target: 'node',
	format: 'esm',
	naming: 'index.js',
	external: ['@opencode-ai/plugin'],
})

if (!result.success) {
	for (const log of result.logs) {
		console.error(log)
	}
	process.exit(1)
}
