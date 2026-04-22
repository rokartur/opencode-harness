import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileExists } from '../shared/fs.js'
import type { GraphLiteService } from './graph-lite.js'

export interface CodeIntelOutline {
	filePath: string
	symbols: Array<{
		name: string
		kind: string
		line: number
		isExported: boolean
	}>
	lineCount: number
}

export interface CodeIntelDefinition {
	symbolName: string
	filePath: string
	line: number
	kind: string
}

export interface CodeIntelSearchResult {
	filePath: string
	line: number
	column: number
	text: string
}

export interface CodeIntelAstSearchResult {
	filePath: string
	startLine: number
	startColumn: number
	endLine: number
	endColumn: number
	text: string
	language: string
}

export interface CodeIntelOptions {
	enabled: boolean
	cwd: string
}

export interface CodeIntelAstSearchOptions {
	path?: string
	lang?: string
	limit?: number
}

export class CodeIntelService {
	private readonly enabled: boolean
	private readonly cwd: string
	private readonly rgAvailable: boolean
	private readonly astGrepBinary: string | null

	constructor(options: CodeIntelOptions) {
		this.enabled = options.enabled
		this.cwd = options.cwd
		this.rgAvailable = this.checkRg()
		this.astGrepBinary = this.detectAstGrepBinary()
	}

	isEnabled(): boolean {
		return this.enabled
	}

	getOutline(filePath: string): CodeIntelOutline | null {
		if (!this.enabled) return null
		const absPath = resolve(this.cwd, filePath)
		if (!fileExists(absPath)) return null
		try {
			const content = readFileSync(absPath, 'utf-8')
			const lines = content.split('\n')
			const symbols = extractOutlineSymbols(content)
			return {
				filePath,
				symbols,
				lineCount: lines.length,
			}
		} catch {
			return null
		}
	}

	findDefinition(symbolName: string, graphLite: GraphLiteService): CodeIntelDefinition[] {
		if (!this.enabled) return []
		const results = graphLite.searchSymbols(symbolName, 10)
		return results
			.filter(r => r.symbol.isExported)
			.map(r => ({
				symbolName: r.symbol.name,
				filePath: r.filePath,
				line: r.symbol.line,
				kind: r.symbol.kind,
			}))
	}

	findReferences(symbolName: string, includePattern?: string, limit: number = 50): CodeIntelSearchResult[] {
		if (!this.enabled || !this.rgAvailable) return []
		const args = ['--line-number', '--column', '--max-count', String(limit), '--no-heading']
		if (includePattern) args.push('--glob', includePattern)
		args.push(`\\b${escapeRegex(symbolName)}\\b`, this.cwd)
		try {
			const result = spawnSync('rg', args, {
				cwd: this.cwd,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 10000,
			})
			if (result.status !== 0 && result.status !== 1) return []
			const output = (result.stdout ?? '').trim()
			if (!output) return []
			return output
				.split('\n')
				.filter(Boolean)
				.map(line => {
					const match = line.match(/^([^:]+):(\d+):(\d+):(.*)$/)
					if (!match) return null
					const relPath = match[1]?.startsWith(this.cwd)
						? match[1].slice(this.cwd.length + 1)
						: (match[1] ?? '')
					return {
						filePath: relPath,
						line: Number.parseInt(match[2] ?? '0', 10),
						column: Number.parseInt(match[3] ?? '0', 10),
						text: (match[4] ?? '').trim(),
					}
				})
				.filter((r): r is CodeIntelSearchResult => r !== null)
		} catch {
			return []
		}
	}

	hasAstSearch(): boolean {
		return this.astGrepBinary !== null
	}

	astSearch(pattern: string, options: CodeIntelAstSearchOptions = {}): CodeIntelAstSearchResult[] | null {
		if (!this.enabled) return []
		if (!this.astGrepBinary) return null
		const targetPath = resolve(this.cwd, options.path ?? '.')
		if (options.path && !fileExists(targetPath)) return []
		const args = ['run', '--pattern', pattern, '--json=compact']
		if (options.lang) args.push('--lang', options.lang)
		args.push(targetPath)
		try {
			const result = spawnSync(this.astGrepBinary, args, {
				cwd: this.cwd,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 15_000,
				maxBuffer: 10 * 1024 * 1024,
			})
			const raw = (result.stdout ?? '').trim()
			if (!raw) return []
			const parsed = JSON.parse(raw) as unknown
			const rows = Array.isArray(parsed) ? parsed : []
			const matches = rows
				.map(row => mapAstSearchResult(this.cwd, row))
				.filter((row): row is CodeIntelAstSearchResult => row !== null)
			return matches.slice(0, options.limit ?? 50)
		} catch {
			return []
		}
	}

	private checkRg(): boolean {
		try {
			const result = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 })
			return result.status === 0
		} catch {
			return false
		}
	}

	private detectAstGrepBinary(): string | null {
		for (const candidate of [resolve(this.cwd, 'ast-grep'), resolve(this.cwd, 'sg'), 'ast-grep', 'sg']) {
			try {
				const result = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 3000 })
				if (result.status === 0) return candidate
			} catch {
				// ignore
			}
		}
		return null
	}
}

function extractOutlineSymbols(
	content: string,
): Array<{ name: string; kind: string; line: number; isExported: boolean }> {
	const symbols: Array<{ name: string; kind: string; line: number; isExported: boolean }> = []
	const seen = new Set<string>()
	const lines = content.split('\n')
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		const match =
			line.match(/^\s*(export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?const\s+([A-Za-z_$][\w$]*)/) ||
			line.match(/^\s*(export\s+)?let\s+([A-Za-z_$][\w$]*)/)
		if (!match) continue
		const name = match[2]
		if (!name || seen.has(name)) continue
		seen.add(name)
		const exported = Boolean(match[1]?.trim())
		const keyword =
			line
				.replace(/^\s*export\s+/, '')
				.trim()
				.split(/\s+/)[0] ?? 'symbol'
		symbols.push({ name, kind: keyword, line: index + 1, isExported: exported })
	}
	return symbols
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mapAstSearchResult(cwd: string, row: unknown): CodeIntelAstSearchResult | null {
	if (!row || typeof row !== 'object') return null
	const record = row as Record<string, unknown>
	const file = typeof record.file === 'string' ? record.file : ''
	const range = record.range && typeof record.range === 'object' ? (record.range as Record<string, unknown>) : null
	const start = range?.start && typeof range.start === 'object' ? (range.start as Record<string, unknown>) : null
	const end = range?.end && typeof range.end === 'object' ? (range.end as Record<string, unknown>) : null
	if (!file || !start || !end) return null
	const relativePath = file.startsWith(cwd) ? file.slice(cwd.length + 1) : file
	return {
		filePath: relativePath,
		startLine: Number(start.line ?? 0) + 1,
		startColumn: Number(start.column ?? 0) + 1,
		endLine: Number(end.line ?? 0) + 1,
		endColumn: Number(end.column ?? 0) + 1,
		text: typeof record.text === 'string' ? record.text : '',
		language: typeof record.language === 'string' ? record.language : '',
	}
}
