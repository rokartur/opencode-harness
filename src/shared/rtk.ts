import { spawnSync } from 'node:child_process'
import type { ToolCompressionMode, ToolCompressionRecord } from '../runtime/types.js'

type RtkRewriteResolver = (command: string, binary: string) => string

export type RtkFallbackMode = 'passthrough' | 'proxy'

export interface RtkCommandCompressionResult extends ToolCompressionRecord {
	originalCommand: string
	finalCommand: string
}

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
	return resolveRtkCommandCompression(command, {
		binary,
		fallbackMode: 'proxy',
		available: true,
		resolveRewrite,
	}).finalCommand
}

export function resolveRtkCommandCompression(
	command: string,
	options: {
		binary?: string
		fallbackMode?: RtkFallbackMode
		available?: boolean
		resolveRewrite?: RtkRewriteResolver
	} = {},
): RtkCommandCompressionResult {
	const binary = options.binary ?? 'rtk'
	const fallbackMode = options.fallbackMode ?? 'passthrough'
	const resolveRewrite = options.resolveRewrite ?? resolveRtkRewrite
	const trimmed = command.trim()
	if (!trimmed) {
		return buildResult('skipped', command, command, 'empty command')
	}
	if (options.available === false) {
		return buildResult('unavailable', command, command, `RTK binary '${binary}' unavailable`)
	}
	if (trimmed === binary || trimmed.startsWith(`${binary} `)) {
		return buildResult('skipped', command, command, 'command already uses RTK')
	}

	const rewritten = normalizeRewrittenCommand(resolveRewrite(trimmed, binary), binary)
	if (rewritten && rewritten !== command) {
		return buildResult('rewritten', command, rewritten, 'RTK rewrite applied')
	}
	if (fallbackMode === 'proxy') {
		const safeBinary = shellQuote(binary)
		return buildResult(
			'proxied',
			command,
			`${safeBinary} proxy sh -lc ${shellQuote(trimmed)}`,
			'RTK proxy fallback applied',
		)
	}
	return buildResult('skipped', command, command, 'no RTK rewrite available')
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

function buildResult(
	mode: ToolCompressionMode,
	originalCommand: string,
	finalCommand: string,
	reason: string,
): RtkCommandCompressionResult {
	return {
		mode,
		originalCommand,
		finalCommand,
		baselineChars: originalCommand.length,
		compressedChars: finalCommand.length,
		reason,
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}
