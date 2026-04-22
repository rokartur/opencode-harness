import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dirExists, ensureDir } from '../shared/fs.js'

export type DoctorStatus = 'OK' | 'WARN' | 'FAIL'

export interface DoctorCheckResult {
	id: string
	status: DoctorStatus
	message: string
	detail?: string
}

export interface DoctorReport {
	checks: DoctorCheckResult[]
	summary: { ok: number; warn: number; fail: number }
	ready: boolean
}

export interface DoctorProbeContext {
	cwd: string
	runtimeDataDir: string
	config: {
		enableMemory: boolean
		enableHooks: boolean
		enableCompaction: boolean
		enableSessionRetry: boolean
		enableSessionRecovery: boolean
		enableSessionPrimer: boolean
		enableProgressiveCheckpoints: boolean
		enableGraphLite: boolean
		enableHashAnchoredPatch: boolean
		enableDelegate: boolean
		enableCodeIntel: boolean
		enableCommentChecker: boolean
		enableCodeStats: boolean
		enableRtk: boolean
		enableCavememBridge: boolean
		enableCavememMcp: boolean
		enablePendingTodoReminders: boolean
		enableSnapshots: boolean
		enableToolArchive: boolean
		enableDeltaRead: boolean
	}
	binaries: {
		rtkAvailable: boolean
		cavememAvailable: boolean
		rgAvailable: boolean
		astGrepAvailable: boolean
		gitAvailable: boolean
		bunAvailable: boolean
	}
	plugins: {
		discovered: number
		enabled: number
		blocked: number
		malformed: number
	}
	graphLiteStatus: { state: string; ready: boolean; stats?: { files: number; symbols: number } } | null
	specPresent: boolean
}

export function runDoctorProbes(ctx: DoctorProbeContext): DoctorReport {
	const checks: DoctorCheckResult[] = []

	checks.push(probeWritableRuntimeDir(ctx))
	checks.push(probeSpecPresence(ctx))
	checks.push(probeGitAvailability(ctx))
	checks.push(probeBunAvailability(ctx))
	checks.push(probeRgAvailability(ctx))
	checks.push(probeRtkConsistency(ctx))
	checks.push(probeCavememConsistency(ctx))
	checks.push(probeGraphLiteConsistency(ctx))
	checks.push(probeHashPatchConsistency(ctx))
	checks.push(probeDelegateConsistency(ctx))
	checks.push(probeCodeIntelConsistency(ctx))
	checks.push(probeCommentCheckerConsistency(ctx))
	checks.push(probeCodeStatsConsistency(ctx))
	checks.push(probePluginHealth(ctx))
	checks.push(probeMemoryConfig(ctx))
	checks.push(probeSessionFeatures(ctx))
	checks.push(probeCheckpointDir(ctx))

	const ok = checks.filter(c => c.status === 'OK').length
	const warn = checks.filter(c => c.status === 'WARN').length
	const fail = checks.filter(c => c.status === 'FAIL').length

	return { checks, summary: { ok, warn, fail }, ready: fail === 0 }
}

export function renderDoctorReport(report: DoctorReport, verbose: boolean = false): string {
	const lines: string[] = [
		'## OpenHarness Doctor',
		'',
		`Summary: ${report.summary.ok} OK | ${report.summary.warn} WARN | ${report.summary.fail} FAIL`,
		`Ready: ${report.ready ? 'yes' : 'no'}`,
		'',
		'### Checks',
	]

	for (const check of report.checks) {
		const tag = check.status
		if (!verbose && check.status === 'OK' && !check.detail) {
			continue
		}
		const suffix = check.detail && verbose ? ` (${check.detail})` : ''
		lines.push(`- [${tag}] ${check.id}: ${check.message}${suffix}`)
	}

	if (!verbose) {
		const nonOk = report.checks.filter(c => c.status !== 'OK')
		if (nonOk.length === 0) {
			lines.push('- All checks OK.')
		}
	}

	return lines.join('\n')
}

export function renderDoctorSummary(report: DoctorReport): string {
	if (report.summary.fail > 0) return `doctor: ${report.summary.fail} FAIL, ${report.summary.warn} WARN`
	if (report.summary.warn > 0) return `doctor: ${report.summary.warn} WARN, all else OK`
	return 'doctor: all checks OK'
}

export function checkBinary(name: string): boolean {
	try {
		const result = spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 3000 })
		return result.status === 0
	} catch {
		return false
	}
}

// --- individual probes ---

function probeWritableRuntimeDir(ctx: DoctorProbeContext): DoctorCheckResult {
	try {
		ensureDir(ctx.runtimeDataDir)
		const probe = join(ctx.runtimeDataDir, '.doctor-write-probe')
		writeFileSync(probe, 'ok', 'utf-8')
		rmSync(probe, { force: true })
		return { id: 'runtime-dir', status: 'OK', message: 'Runtime dir is writable' }
	} catch (error) {
		return {
			id: 'runtime-dir',
			status: 'FAIL',
			message: 'Runtime dir is not writable',
			detail: error instanceof Error ? error.message : String(error),
		}
	}
}

function probeSpecPresence(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.specPresent) return { id: 'spec', status: 'OK', message: 'SPEC.md present' }
	return {
		id: 'spec',
		status: 'WARN',
		message: 'SPEC.md missing',
		detail: 'CaveKit spec-driven workflows require SPEC.md',
	}
}

function probeGitAvailability(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.binaries.gitAvailable) return { id: 'git', status: 'OK', message: 'git available' }
	return {
		id: 'git',
		status: 'WARN',
		message: 'git not found',
		detail: 'Session primer and snapshot features rely on git',
	}
}

function probeBunAvailability(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.binaries.bunAvailable) return { id: 'bun', status: 'OK', message: 'bun available' }
	return {
		id: 'bun',
		status: 'WARN',
		message: 'bun not found',
		detail: 'Project uses bun for typecheck/test/build verification',
	}
}

function probeRgAvailability(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.binaries.rgAvailable) return { id: 'rg', status: 'OK', message: 'ripgrep (rg) available for fast search' }
	return {
		id: 'rg',
		status: 'WARN',
		message: 'ripgrep (rg) not found',
		detail: 'Host-side grep fast-path unavailable; builtin fallback used',
	}
}

function probeRtkConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableRtk) return { id: 'rtk', status: 'OK', message: 'RTK disabled (not required)' }
	if (ctx.binaries.rtkAvailable) return { id: 'rtk', status: 'OK', message: 'RTK enabled and binary available' }
	return {
		id: 'rtk',
		status: 'WARN',
		message: 'RTK enabled but binary unavailable',
		detail: 'L02 tool compression will fall back to passthrough',
	}
}

function probeCavememConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableCavememBridge && !ctx.config.enableCavememMcp) {
		return { id: 'cavemem', status: 'OK', message: 'CaveMem disabled (not required)' }
	}
	if (ctx.config.enableCavememMcp && !ctx.binaries.cavememAvailable) {
		return {
			id: 'cavemem',
			status: 'WARN',
			message: 'CaveMem MCP enabled but binary unavailable',
			detail: 'Will fall back to local bridge tools',
		}
	}
	if (ctx.binaries.cavememAvailable)
		return { id: 'cavemem', status: 'OK', message: 'CaveMem enabled and binary available' }
	return {
		id: 'cavemem',
		status: 'WARN',
		message: 'CaveMem enabled but binary unavailable',
		detail: 'Memory features degraded',
	}
}

function probeGraphLiteConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableGraphLite)
		return { id: 'graph-lite', status: 'OK', message: 'Graph-lite disabled (not required)' }
	if (!ctx.graphLiteStatus)
		return { id: 'graph-lite', status: 'WARN', message: 'Graph-lite enabled but status unavailable' }
	if (ctx.graphLiteStatus.ready) {
		const stats = ctx.graphLiteStatus.stats
		return {
			id: 'graph-lite',
			status: 'OK',
			message: `Graph-lite ready (${stats?.files ?? 0} files, ${stats?.symbols ?? 0} symbols)`,
		}
	}
	return {
		id: 'graph-lite',
		status: 'WARN',
		message: `Graph-lite enabled but ${ctx.graphLiteStatus.state}`,
		detail: 'Run openharness_graph_status action="scan" to build index',
	}
}

function probeHashPatchConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableHashAnchoredPatch) {
		return { id: 'hash-patch', status: 'OK', message: 'Hash-anchored patch disabled (not required)' }
	}
	return { id: 'hash-patch', status: 'OK', message: 'Hash-anchored patch enabled' }
}

function probePluginHealth(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.plugins.malformed > 0) {
		return {
			id: 'plugins',
			status: 'WARN',
			message: `${ctx.plugins.malformed} malformed plugin(s) detected`,
			detail: 'Run openharness_diagnostics for details',
		}
	}
	if (ctx.plugins.blocked > 0) {
		return {
			id: 'plugins',
			status: 'WARN',
			message: `${ctx.plugins.blocked} blocked plugin(s)`,
			detail: 'Blocked plugins are disabled by policy',
		}
	}
	return {
		id: 'plugins',
		status: 'OK',
		message: `${ctx.plugins.discovered} plugins discovered, ${ctx.plugins.enabled} enabled`,
	}
}

function probeMemoryConfig(ctx: DoctorProbeContext): DoctorCheckResult {
	if (ctx.config.enableMemory) return { id: 'memory', status: 'OK', message: 'Memory enabled' }
	return {
		id: 'memory',
		status: 'WARN',
		message: 'Memory disabled',
		detail: 'Project memory recall and CaveMem bridge inactive',
	}
}

function probeSessionFeatures(ctx: DoctorProbeContext): DoctorCheckResult {
	const enabled: string[] = []
	const disabled: string[] = []
	if (ctx.config.enableSessionRetry) {
		enabled.push('retry')
	} else {
		disabled.push('retry')
	}
	if (ctx.config.enableSessionPrimer) {
		enabled.push('primer')
	} else {
		disabled.push('primer')
	}
	if (ctx.config.enableProgressiveCheckpoints) {
		enabled.push('checkpoints')
	} else {
		disabled.push('checkpoints')
	}
	if (ctx.config.enablePendingTodoReminders) {
		enabled.push('todo-reminders')
	} else {
		disabled.push('todo-reminders')
	}
	if (enabled.length === 0) {
		return {
			id: 'session-features',
			status: 'WARN',
			message: 'No session features enabled',
			detail: disabled.join(', '),
		}
	}
	return {
		id: 'session-features',
		status: 'OK',
		message: `Enabled: ${enabled.join(', ')}`,
		detail: disabled.length > 0 ? `Disabled: ${disabled.join(', ')}` : undefined,
	}
}

function probeCheckpointDir(ctx: DoctorProbeContext): DoctorCheckResult {
	const cpDir = join(ctx.runtimeDataDir, 'checkpoints')
	if (dirExists(cpDir)) return { id: 'checkpoint-dir', status: 'OK', message: 'Checkpoint dir exists' }
	if (ctx.config.enableProgressiveCheckpoints) {
		return {
			id: 'checkpoint-dir',
			status: 'WARN',
			message: 'Checkpoint dir not yet created',
			detail: 'Will be created on first checkpoint capture',
		}
	}
	return { id: 'checkpoint-dir', status: 'OK', message: 'Checkpoints disabled' }
}

function probeDelegateConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableDelegate) return { id: 'delegate', status: 'OK', message: 'Delegate disabled (not required)' }
	return { id: 'delegate', status: 'OK', message: 'Delegate enabled and service ready' }
}

function probeCodeIntelConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableCodeIntel)
		return { id: 'code-intel', status: 'OK', message: 'Code intel disabled (not required)' }
	if (ctx.binaries.rgAvailable && ctx.binaries.astGrepAvailable) {
		return { id: 'code-intel', status: 'OK', message: 'Code intel enabled with rg + ast-grep support' }
	}
	if (ctx.binaries.rgAvailable) {
		return {
			id: 'code-intel',
			status: 'WARN',
			message: 'Code intel enabled with rg support only',
			detail: 'Reference search works; install ast-grep or sg for read-only AST search',
		}
	}
	if (ctx.binaries.astGrepAvailable) {
		return {
			id: 'code-intel',
			status: 'WARN',
			message: 'Code intel enabled with ast-grep support only',
			detail: 'AST search works; install rg for reference search',
		}
	}
	return {
		id: 'code-intel',
		status: 'WARN',
		message: 'Code intel enabled but rg and ast-grep are unavailable',
		detail: 'Reference search and AST search will be unavailable; outline and definition lookup still work via graph-lite',
	}
}

function probeCommentCheckerConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableCommentChecker) {
		return { id: 'comment-checker', status: 'OK', message: 'Comment checker disabled (not required)' }
	}
	return { id: 'comment-checker', status: 'OK', message: 'Comment checker enabled' }
}

function probeCodeStatsConsistency(ctx: DoctorProbeContext): DoctorCheckResult {
	if (!ctx.config.enableCodeStats) {
		return { id: 'code-stats', status: 'OK', message: 'Code stats disabled (not required)' }
	}
	if (checkBinary('tokei'))
		return { id: 'code-stats', status: 'OK', message: 'Code stats enabled with tokei backend' }
	if (checkBinary('scc')) return { id: 'code-stats', status: 'OK', message: 'Code stats enabled with scc backend' }
	if (ctx.binaries.rgAvailable) {
		return {
			id: 'code-stats',
			status: 'WARN',
			message: 'Code stats enabled with rg fallback only',
			detail: 'Install tokei or scc for LOC stats',
		}
	}
	return {
		id: 'code-stats',
		status: 'WARN',
		message: 'Code stats enabled but no backend available',
		detail: 'Requires tokei, scc, or rg',
	}
}
