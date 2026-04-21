import { spawnSync } from 'node:child_process'

type RtkRewriteResolver = (command: string, binary: string) => string

export function isRtkAvailable(binary: string): boolean {
	try {
		const result = spawnSync(binary, ['--version'], { stdio: 'ignore' })
		return result.status === 0
	} catch {
		return false
	}
}

export function rewriteCommandWithRtk(
	command: string,
	binary: string = 'rtk',
	resolveRewrite: RtkRewriteResolver = resolveRtkRewrite,
): string {
	const trimmed = command.trim()
	if (!trimmed) return command
	if (trimmed === binary || trimmed.startsWith(`${binary} `)) return command

	const rewritten = normalizeRewrittenCommand(resolveRewrite(trimmed, binary), binary)
	if (rewritten) return rewritten

	const safeBinary = shellQuote(binary)
	return `${safeBinary} proxy sh -lc ${shellQuote(trimmed)}`
}

function resolveRtkRewrite(command: string, binary: string): string {
	try {
		const result = spawnSync(binary, ['rewrite', command], { encoding: 'utf-8' })
		if (result.status !== 0) return ''
		return result.stdout.trim()
	} catch {
		return ''
	}
}

function normalizeRewrittenCommand(rewritten: string, binary: string): string {
	if (!rewritten) return ''
	const safeBinary = shellQuote(binary)
	if (rewritten === 'rtk') return safeBinary
	if (rewritten.startsWith('rtk ')) return `${safeBinary}${rewritten.slice(3)}`
	return rewritten
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}
