import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { ensureDir, fileExists, readFileText, writeFileAtomic } from '../shared/fs.js'

export type GraphLiteState = 'unavailable' | 'scanning' | 'ready' | 'stale' | 'error'

export interface GraphLiteSymbol {
	name: string
	kind: string
	line: number
	isExported: boolean
}

export interface GraphLiteSymbolRef {
	symbolName: string
	sourcePath: string
	line: number
	importedAs?: string
}

export interface GraphLiteSymbolSignature {
	symbolName: string
	filePath: string
	line: number
	kind: string
	signature: string
}

export interface GraphLiteSymbolReference {
	symbolName: string
	filePath: string
	line: number
	kind: 'import'
	context: string
}

export interface GraphLiteSymbolBlastRadius {
	root: { name: string; path: string; line: number }
	totalAffected: number
	affected: Array<{ name: string; path: string; line: number; depth: number }>
}

export interface GraphLiteCallCycle {
	cycle: Array<{ name: string; path: string; line: number }>
}

export interface GraphLiteUnusedExport {
	symbolName: string
	filePath: string
	line: number
	kind: string
}

export interface GraphLiteDuplicateBlock {
	hash: string
	snippet: string
	occurrences: Array<{ filePath: string; startLine: number; endLine: number }>
}

export interface GraphLiteNearDuplicate {
	leftPath: string
	rightPath: string
	similarity: number
}

export interface GraphLiteBlastRadiusDetail {
	count: number
	files: string[]
	scores: Array<{ path: string; depth: number }>
}

export interface GraphLiteCoChangeHint {
	path: string
	sharedDependents: number
	sharedDependencies: number
	score: number
}

export interface GraphLitePackageGroup {
	directory: string
	files: string[]
	symbolCount: number
	edgeCount: number
}

export interface GraphLiteFile {
	path: string
	lineCount: number
	dependencies: string[]
	dependents: string[]
	symbols: GraphLiteSymbol[]
	symbolRefs: GraphLiteSymbolRef[]
	score: number
}

export interface GraphLiteStats {
	files: number
	symbols: number
	edges: number
	symbolRefs: number
}

export interface GraphLiteStatus {
	state: GraphLiteState
	ready: boolean
	updatedAt: number
	message?: string
	stats?: GraphLiteStats
}

interface GraphLiteIndex {
	updatedAt: number
	stats: GraphLiteStats
	files: GraphLiteFile[]
}

const INDEXABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.openharness'])

export class GraphLiteService {
	private status: GraphLiteStatus
	private index: GraphLiteIndex | null = null

	constructor(
		private readonly cwd: string,
		private readonly cacheDir: string,
		private readonly enabled: boolean,
		private readonly maxFiles: number = 2000,
		private readonly staleAfterMs: number = 15 * 60 * 1000,
	) {
		this.status = this.enabled
			? { state: 'unavailable', ready: false, updatedAt: 0 }
			: { state: 'unavailable', ready: false, updatedAt: 0, message: 'graph-lite disabled' }
		this.loadFromDisk()
	}

	getStatus(): GraphLiteStatus {
		this.refreshFreshness()
		return { ...this.status }
	}

	async scan(): Promise<GraphLiteStatus> {
		if (!this.enabled) {
			this.status = { state: 'unavailable', ready: false, updatedAt: Date.now(), message: 'graph-lite disabled' }
			return this.getStatus()
		}
		try {
			this.status = { state: 'scanning', ready: false, updatedAt: Date.now(), message: 'scanning repository' }
			const filePaths = walkIndexableFiles(this.cwd, this.maxFiles)
			const fileMap = new Map<string, GraphLiteFile>()
			for (const relPath of filePaths) {
				const absPath = resolve(this.cwd, relPath)
				const content = readFileText(absPath)
				if (!content) continue
				const dependencies = extractDependencies(content, absPath, this.cwd)
				const symbols = extractSymbols(content)
				const lineCount = content.split('\n').length
				const symbolRefs = extractSymbolRefs(content, absPath, this.cwd)
				fileMap.set(relPath, {
					path: relPath,
					lineCount,
					dependencies,
					dependents: [],
					symbols,
					symbolRefs,
					score: 0,
				})
			}
			for (const file of fileMap.values()) {
				file.dependencies = file.dependencies.filter(dep => fileMap.has(dep))
				for (const dep of file.dependencies) fileMap.get(dep)?.dependents.push(file.path)
			}
			for (const file of fileMap.values()) {
				file.dependents = uniqueStrings(file.dependents)
				file.score =
					file.dependents.length * 3 +
					file.dependencies.length +
					file.symbols.length * 0.5 +
					file.lineCount / 200
			}
			const files = Array.from(fileMap.values()).sort(
				(left, right) => right.score - left.score || left.path.localeCompare(right.path),
			)
			const stats: GraphLiteStats = {
				files: files.length,
				symbols: files.reduce((sum, file) => sum + file.symbols.length, 0),
				edges: files.reduce((sum, file) => sum + file.dependencies.length, 0),
				symbolRefs: files.reduce((sum, file) => sum + file.symbolRefs.length, 0),
			}
			this.index = { updatedAt: Date.now(), stats, files }
			this.status = { state: 'ready', ready: true, updatedAt: this.index.updatedAt, stats }
			this.persist()
			return this.getStatus()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.status = { state: 'error', ready: false, updatedAt: Date.now(), message }
			this.persistStatus()
			return this.getStatus()
		}
	}

	getTopFiles(limit: number = 10): Array<{ path: string; score: number; lines: number; symbols: number }> {
		return (this.index?.files ?? []).slice(0, limit).map(file => ({
			path: file.path,
			score: file.score,
			lines: file.lineCount,
			symbols: file.symbols.length,
		}))
	}

	getFileSymbols(path: string): GraphLiteSymbol[] {
		return this.findFile(path)?.symbols ?? []
	}

	getFileDependencies(path: string): string[] {
		return this.findFile(path)?.dependencies ?? []
	}

	getFileDependents(path: string): string[] {
		return this.findFile(path)?.dependents ?? []
	}

	getBlastRadius(path: string): number {
		return this.getBlastRadiusDetail(path).count
	}

	getBlastRadiusDetail(path: string): GraphLiteBlastRadiusDetail {
		const start = this.findFile(path)
		if (!start) return { count: 0, files: [], scores: [] }
		const queue: Array<{ path: string; depth: number }> = start.dependents.map(d => ({ path: d, depth: 1 }))
		const seen = new Map<string, number>()
		for (const dep of start.dependents) {
			if (!seen.has(dep)) seen.set(dep, 1)
		}
		while (queue.length > 0) {
			const next = queue.shift()!
			const currentDepth = seen.get(next.path) ?? next.depth
			for (const dependent of this.getFileDependents(next.path)) {
				if (!seen.has(dependent)) {
					const newDepth = currentDepth + 1
					seen.set(dependent, newDepth)
					queue.push({ path: dependent, depth: newDepth })
				}
			}
		}
		const files = Array.from(seen.keys()).sort()
		const scores = Array.from(seen.entries())
			.map(([p, depth]) => ({ path: p, depth }))
			.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
		return { count: seen.size, files, scores }
	}

	searchSymbols(query: string, limit: number = 20): Array<{ symbol: GraphLiteSymbol; filePath: string }> {
		if (!this.index) return []
		const needle = query.toLowerCase().trim()
		if (!needle) return []
		const results: Array<{ symbol: GraphLiteSymbol; filePath: string; matchScore: number }> = []
		for (const file of this.index.files) {
			for (const symbol of file.symbols) {
				const lower = symbol.name.toLowerCase()
				let matchScore = 0
				if (lower === needle) matchScore = 4
				else if (lower.startsWith(needle)) matchScore = 3
				else if (lower.includes(needle)) matchScore = 2
				else if (needle.split('').every(ch => lower.includes(ch))) matchScore = 1
				if (matchScore > 0) {
					results.push({ symbol, filePath: file.path, matchScore })
				}
			}
		}
		return results
			.sort((a, b) => b.matchScore - a.matchScore || a.filePath.localeCompare(b.filePath))
			.slice(0, limit)
			.map(({ symbol, filePath }) => ({ symbol, filePath }))
	}

	getCallers(filePath: string, symbolName: string): Array<{ filePath: string; symbolName: string }> {
		const results: Array<{ filePath: string; symbolName: string }> = []
		if (!this.index) return results
		const targetLower = symbolName.toLowerCase()
		for (const file of this.index.files) {
			if (file.path === filePath) continue
			for (const ref of file.symbolRefs) {
				if (ref.sourcePath === filePath && ref.symbolName.toLowerCase() === targetLower) {
					results.push({ filePath: file.path, symbolName: ref.symbolName })
				}
			}
		}
		return results
	}

	getCallees(filePath: string): Array<{ symbolName: string; sourcePath: string }> {
		return this.findFile(filePath)?.symbolRefs ?? []
	}

	getSymbolSignature(filePath: string, symbolName: string): GraphLiteSymbolSignature | null {
		const file = this.findFile(filePath)
		if (!file) return null
		const symbol =
			file.symbols.find(entry => entry.name.toLowerCase() === symbolName.toLowerCase()) ??
			file.symbols.find(entry => entry.name === symbolName)
		if (!symbol) return null
		const content = readFileText(resolve(this.cwd, file.path))
		if (!content) return null
		const lines = content.split('\n')
		return {
			symbolName: symbol.name,
			filePath: file.path,
			line: symbol.line,
			kind: symbol.kind,
			signature: extractSignature(lines, symbol.line),
		}
	}

	getSymbolReferences(symbolName: string, limit: number = 20): GraphLiteSymbolReference[] {
		if (!this.index) return []
		const needle = symbolName.toLowerCase().trim()
		if (!needle) return []
		const results: GraphLiteSymbolReference[] = []
		for (const file of this.index.files) {
			const content = readFileText(resolve(this.cwd, file.path))
			const lines = content ? content.split('\n') : []
			for (const ref of file.symbolRefs) {
				if (ref.symbolName.toLowerCase() !== needle) continue
				const line = Number.isFinite(ref.line) ? ref.line : 0
				results.push({
					symbolName: ref.symbolName,
					filePath: file.path,
					line,
					kind: 'import',
					context: line > 0 ? (lines[line - 1] ?? '').trim() : '',
				})
				if (results.length >= limit) return results
			}
		}
		return results
	}

	getSymbolBlastRadius(symbolName: string, maxDepth: number = 5): GraphLiteSymbolBlastRadius {
		const root = this.resolvePrimarySymbol(symbolName)
		if (!root) {
			return {
				root: { name: symbolName, path: '', line: 0 },
				totalAffected: 0,
				affected: [],
			}
		}
		const affected: Array<{ name: string; path: string; line: number; depth: number }> = []
		const queue: Array<{ filePath: string; symbolName: string; depth: number }> = [
			{ filePath: root.filePath, symbolName: root.symbol.name, depth: 0 },
		]
		const seen = new Set<string>([`${root.filePath}::${root.symbol.name.toLowerCase()}`])
		while (queue.length > 0) {
			const current = queue.shift()!
			if (current.depth >= maxDepth) continue
			const callers = this.getCallers(current.filePath, current.symbolName)
			for (const caller of callers) {
				const callerFile = this.findFile(caller.filePath)
				if (!callerFile) continue
				const propagated = callerFile.symbols.filter(symbol => symbol.isExported)
				const symbols = propagated.length > 0 ? propagated : callerFile.symbols.slice(0, 1)
				for (const symbol of symbols) {
					const key = `${callerFile.path}::${symbol.name.toLowerCase()}`
					if (seen.has(key)) continue
					seen.add(key)
					affected.push({
						name: symbol.name,
						path: callerFile.path,
						line: symbol.line,
						depth: current.depth + 1,
					})
					queue.push({ filePath: callerFile.path, symbolName: symbol.name, depth: current.depth + 1 })
				}
			}
		}
		affected.sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path))
		return {
			root: { name: root.symbol.name, path: root.filePath, line: root.symbol.line },
			totalAffected: affected.length,
			affected,
		}
	}

	getCallGraphCycles(limit: number = 10): GraphLiteCallCycle[] {
		return this.getCircularDependencyCycles(limit).map(cycle => ({
			cycle: cycle.map(path => {
				const file = this.findFile(path)
				const symbol = file?.symbols.find(entry => entry.isExported) ?? file?.symbols[0]
				return {
					name: symbol?.name ?? fallbackSymbolName(path),
					path,
					line: symbol?.line ?? 1,
				}
			}),
		}))
	}

	getCircularDependencyCycles(limit: number = 10): string[][] {
		if (!this.index) return []
		const cycles: string[][] = []
		const seen = new Set<string>()
		const visit = (path: string, stack: string[], active: Set<string>) => {
			const cycleStart = stack.indexOf(path)
			if (cycleStart >= 0) {
				const cycle = stack.slice(cycleStart)
				if (cycle.length >= 2) {
					const key = canonicalizeCycle(cycle)
					if (!seen.has(key)) {
						seen.add(key)
						cycles.push(cycle)
					}
				}
				return
			}
			if (active.has(path)) return
			active.add(path)
			stack.push(path)
			for (const dep of this.getFileDependencies(path)) {
				visit(dep, stack, active)
				if (cycles.length >= limit) break
			}
			stack.pop()
			active.delete(path)
		}
		for (const file of this.index.files) {
			visit(file.path, [], new Set())
			if (cycles.length >= limit) break
		}
		return cycles.slice(0, limit)
	}

	getUnusedExports(limit: number = 20): GraphLiteUnusedExport[] {
		if (!this.index) return []
		const imported = new Set<string>()
		for (const file of this.index.files) {
			for (const ref of file.symbolRefs) {
				imported.add(`${ref.sourcePath}::${ref.symbolName.toLowerCase()}`)
			}
		}
		const results: GraphLiteUnusedExport[] = []
		for (const file of this.index.files) {
			for (const symbol of file.symbols) {
				if (!symbol.isExported) continue
				if (imported.has(`${file.path}::${symbol.name.toLowerCase()}`)) continue
				results.push({ symbolName: symbol.name, filePath: file.path, line: symbol.line, kind: symbol.kind })
			}
		}
		return results.slice(0, limit)
	}

	getDuplicateBlocks(limit: number = 10, windowSize: number = 3): GraphLiteDuplicateBlock[] {
		if (!this.index) return []
		const occurrences = new Map<
			string,
			Array<{ filePath: string; startLine: number; endLine: number; snippet: string }>
		>()
		for (const file of this.index.files) {
			const content = readFileText(resolve(this.cwd, file.path))
			if (!content) continue
			const lines = content.split('\n')
			for (let index = 0; index <= lines.length - windowSize; index++) {
				const slice = lines.slice(index, index + windowSize)
				const normalized = slice.map(normalizeDuplicateLine)
				if (!isMeaningfulDuplicateWindow(normalized)) continue
				const key = normalized.join('\n')
				const next = occurrences.get(key) ?? []
				next.push({
					filePath: file.path,
					startLine: index + 1,
					endLine: index + windowSize,
					snippet: slice.join('\n').trim(),
				})
				occurrences.set(key, next)
			}
		}
		return Array.from(occurrences.entries())
			.filter(([, hits]) => hits.length > 1)
			.sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
			.slice(0, limit)
			.map(([hash, hits]) => ({
				hash,
				snippet: hits[0]?.snippet ?? '',
				occurrences: hits.map(hit => ({
					filePath: hit.filePath,
					startLine: hit.startLine,
					endLine: hit.endLine,
				})),
			}))
	}

	getNearDuplicateFiles(limit: number = 10, threshold: number = 0.85): GraphLiteNearDuplicate[] {
		if (!this.index) return []
		const samples = this.index.files.slice(0, 250).map(file => ({
			path: file.path,
			lines: file.lineCount,
			fingerprint: buildNearDuplicateFingerprint(readFileText(resolve(this.cwd, file.path)) ?? ''),
		}))
		const results: GraphLiteNearDuplicate[] = []
		for (let left = 0; left < samples.length; left++) {
			for (let right = left + 1; right < samples.length; right++) {
				const a = samples[left]
				const b = samples[right]
				if (!a || !b || a.fingerprint.size === 0 || b.fingerprint.size === 0) continue
				const maxLines = Math.max(a.lines, b.lines)
				if (maxLines > 0 && Math.abs(a.lines - b.lines) / maxLines > 0.4) continue
				const similarity = computeSetSimilarity(a.fingerprint, b.fingerprint)
				if (similarity < threshold) continue
				results.push({ leftPath: a.path, rightPath: b.path, similarity })
			}
		}
		return results
			.sort((left, right) => right.similarity - left.similarity || left.leftPath.localeCompare(right.leftPath))
			.slice(0, limit)
	}

	getCoChangeHints(path: string, limit: number = 10): GraphLiteCoChangeHint[] {
		const target = this.findFile(path)
		if (!target || !this.index) return []
		const targetDependents = new Set(target.dependents)
		const targetDeps = new Set(target.dependencies)
		const hints: GraphLiteCoChangeHint[] = []
		for (const file of this.index.files) {
			if (file.path === target.path) continue
			const sharedDependents = file.dependents.filter(d => targetDependents.has(d)).length
			const sharedDependencies = file.dependencies.filter(d => targetDeps.has(d)).length
			const score = sharedDependents * 3 + sharedDependencies * 2
			if (score > 0) {
				hints.push({ path: file.path, sharedDependents, sharedDependencies, score })
			}
		}
		return hints.sort((a, b) => b.score - a.score).slice(0, limit)
	}

	getPackageGroups(): GraphLitePackageGroup[] {
		if (!this.index) return []
		const groups = new Map<string, GraphLitePackageGroup>()
		for (const file of this.index.files) {
			const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.'
			const existing = groups.get(dir)
			if (existing) {
				existing.files.push(file.path)
				existing.symbolCount += file.symbols.length
				existing.edgeCount += file.dependencies.length
			} else {
				groups.set(dir, {
					directory: dir,
					files: [file.path],
					symbolCount: file.symbols.length,
					edgeCount: file.dependencies.length,
				})
			}
		}
		return Array.from(groups.values()).sort(
			(a, b) => b.files.length - a.files.length || a.directory.localeCompare(b.directory),
		)
	}

	private findFile(path: string): GraphLiteFile | null {
		const normalized = normalizeQueryPath(path)
		return (
			(this.index?.files ?? []).find(file => file.path === normalized || file.path.endsWith(normalized)) ?? null
		)
	}

	private resolvePrimarySymbol(symbolName: string): { filePath: string; symbol: GraphLiteSymbol } | null {
		const needle = symbolName.toLowerCase().trim()
		if (!needle) return null
		const exact = this.searchSymbols(symbolName, 20).find(
			result => result.symbol.name.toLowerCase() === needle && result.symbol.isExported,
		)
		if (exact) return exact
		return this.searchSymbols(symbolName, 1)[0] ?? null
	}

	private loadFromDisk(): void {
		const rawIndex = readFileText(join(this.cacheDir, 'index.json'))
		const rawStatus = readFileText(join(this.cacheDir, 'status.json'))
		if (rawIndex) {
			try {
				this.index = JSON.parse(rawIndex) as GraphLiteIndex
			} catch {
				this.index = null
			}
		}
		if (rawStatus) {
			try {
				this.status = JSON.parse(rawStatus) as GraphLiteStatus
			} catch {
				// ignore corrupted status
			}
		}
		this.refreshFreshness()
	}

	private persist(): void {
		ensureDir(this.cacheDir)
		if (this.index) writeFileAtomic(join(this.cacheDir, 'index.json'), JSON.stringify(this.index, null, 2))
		this.persistStatus()
	}

	private persistStatus(): void {
		ensureDir(this.cacheDir)
		writeFileAtomic(join(this.cacheDir, 'status.json'), JSON.stringify(this.status, null, 2))
	}

	private refreshFreshness(): void {
		if (!this.enabled) return
		if (!this.index || this.index.files.length === 0) return
		const ageMs = Date.now() - this.index.updatedAt
		if (ageMs > this.staleAfterMs) {
			this.status = {
				state: 'stale',
				ready: false,
				updatedAt: this.index.updatedAt,
				stats: this.index.stats,
				message: `index stale (${Math.round(ageMs / 1000)}s old)`,
			}
			return
		}
		this.status = { state: 'ready', ready: true, updatedAt: this.index.updatedAt, stats: this.index.stats }
	}
}

function walkIndexableFiles(cwd: string, maxFiles: number): string[] {
	const files: string[] = []
	function walk(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const absPath = join(dir, entry)
			const relPath = relative(cwd, absPath)
			let stat
			try {
				stat = statSync(absPath)
			} catch {
				continue
			}
			if (stat.isDirectory()) {
				if (IGNORED_DIRS.has(entry)) continue
				walk(absPath)
				continue
			}
			if (!INDEXABLE_EXTS.has(extname(entry).toLowerCase())) continue
			files.push(relPath)
			if (files.length >= maxFiles) return
		}
	}
	if (fileExists(cwd)) walk(cwd)
	return files.sort()
}

function extractDependencies(content: string, absPath: string, cwd: string): string[] {
	const deps = new Set<string>()
	const patterns = [
		/(?:import|export)\s+[^\n]*?from\s+['\"]([^'\"]+)['\"]/g,
		/require\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
		/import\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
	]
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) {
			const specifier = match[1]?.trim()
			if (!specifier || !specifier.startsWith('.')) continue
			const resolved = resolveImportSpecifier(absPath, specifier, cwd)
			if (resolved) deps.add(resolved)
		}
	}
	return Array.from(deps).sort()
}

function resolveImportSpecifier(fromFile: string, specifier: string, cwd: string): string | null {
	const base = resolve(dirname(fromFile), specifier)
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.jsx`,
		join(base, 'index.ts'),
		join(base, 'index.tsx'),
		join(base, 'index.js'),
		join(base, 'index.jsx'),
	]
	for (const candidate of candidates) {
		if (!fileExists(candidate)) continue
		return relative(cwd, candidate)
	}
	return null
}

function extractSymbols(content: string): GraphLiteSymbol[] {
	const symbols: GraphLiteSymbol[] = []
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

function extractSymbolRefs(content: string, absPath: string, cwd: string): GraphLiteSymbolRef[] {
	const refs: GraphLiteSymbolRef[] = []
	const pattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
	for (const match of content.matchAll(pattern)) {
		const start = match.index ?? 0
		const line = content.slice(0, start).split('\n').length
		const names = match[1]?.trim()
		const specifier = match[2]?.trim()
		if (!names || !specifier || !specifier.startsWith('.')) continue
		const resolved = resolveImportSpecifier(absPath, specifier, cwd)
		if (!resolved) continue
		for (const name of names.split(',')) {
			const trimmed = name.trim()
			const aliasMatch = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
			const clean = aliasMatch?.[1]?.trim() ?? trimmed.replace(/\s+as\s+\w+$/, '').trim()
			const importedAs = aliasMatch?.[2]?.trim()
			if (clean) refs.push({ symbolName: clean, sourcePath: resolved, line, importedAs })
		}
	}
	return refs
}

function extractSignature(lines: string[], lineNumber: number): string {
	const start = Math.max(0, lineNumber - 1)
	const collected: string[] = []
	for (let index = start; index < Math.min(lines.length, start + 4); index++) {
		const trimmed = lines[index]?.trim() ?? ''
		if (!trimmed) {
			if (collected.length > 0) break
			continue
		}
		collected.push(trimmed)
		if (/[{;]$/.test(trimmed) || /=>/.test(trimmed) || /\)\s*\{?$/.test(trimmed)) break
	}
	return collected.join(' ').replace(/\s+/g, ' ').trim()
}

function fallbackSymbolName(path: string): string {
	const normalized = normalizeQueryPath(path)
	const parts = normalized.split('/')
	return parts[parts.length - 1]?.replace(/\.[^.]+$/, '') || normalized
}

function canonicalizeCycle(cycle: string[]): string {
	const variants: string[] = []
	for (let index = 0; index < cycle.length; index++) {
		const rotated = cycle.slice(index).concat(cycle.slice(0, index))
		variants.push(rotated.join('>'))
		variants.push(rotated.slice().reverse().join('>'))
	}
	return variants.sort()[0] ?? cycle.join('>')
}

function normalizeDuplicateLine(line: string): string {
	return line
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/\b(function|class|interface|type|enum|const|let)\s+[A-Za-z_$][\w$]*/g, '$1 $__IDENT')
}

function isMeaningfulDuplicateWindow(lines: string[]): boolean {
	if (lines.length === 0) return false
	const joined = lines.join('\n').trim()
	if (joined.length < 40) return false
	return lines.filter(line => /[A-Za-z0-9_$]/.test(line)).length >= Math.min(2, lines.length)
}

function buildNearDuplicateFingerprint(content: string): Set<string> {
	return new Set(
		content
			.split('\n')
			.map(normalizeDuplicateLine)
			.filter(line => line.length >= 8)
			.filter(line => !line.startsWith('import ') && !line.startsWith('export {')),
	)
}

function computeSetSimilarity(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0
	let shared = 0
	for (const value of left) {
		if (right.has(value)) shared++
	}
	const denominator = Math.max(left.size, right.size)
	return denominator === 0 ? 0 : shared / denominator
}

function normalizeQueryPath(path: string): string {
	return path.replace(/^\.\//, '').trim()
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values))
}
