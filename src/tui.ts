import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import { join } from 'node:path'
import { listMemoryFiles } from './memory/manager.js'
import { getProjectMemoryDir } from './memory/paths.js'
import { dirExists } from './shared/fs.js'
import { ensureDir, writeFileAtomic } from './shared/fs.js'
import { statSync } from 'node:fs'
import type { CompatibilityReport } from './shared/types.js'
import { getWorkflowPhaseLabel, type SessionRuntimeSnapshot } from './runtime/index.js'

const z = tool.schema

export interface HookLogEntry {
	timestamp: number
	event: string
	kind: string
	success: boolean
	blocked: boolean
	durationMs: number
	subject?: string
	reason?: string
}

export class HookExecutionLog {
	private entries: HookLogEntry[] = []
	private maxEntries: number

	constructor(maxEntries: number = 100) {
		this.maxEntries = maxEntries
	}

	record(entry: Omit<HookLogEntry, 'timestamp'>): void {
		this.entries.push({ ...entry, timestamp: Date.now() })
		if (this.entries.length > this.maxEntries) {
			this.entries.shift()
		}
	}

	getRecent(count: number = 20): HookLogEntry[] {
		return this.entries.slice(-count)
	}

	getBlocked(): HookLogEntry[] {
		return this.entries.filter(e => e.blocked)
	}

	getFailed(): HookLogEntry[] {
		return this.entries.filter(e => !e.success)
	}

	getStats(): { total: number; success: number; failed: number; blocked: number } {
		return {
			total: this.entries.length,
			success: this.entries.filter(e => e.success).length,
			failed: this.entries.filter(e => !e.success).length,
			blocked: this.entries.filter(e => e.blocked).length,
		}
	}

	clear(): void {
		this.entries = []
	}
}

export function createDiagnosticsTool(
	getReport: () => CompatibilityReport,
	getPlugins: () => Array<{
		name: string
		version: string
		source: string
		enabled: boolean
		blocked: boolean
		commands: number
		agents: number
		hooks: number
		skills: number
		mcpServers: number
	}>,
): ToolDefinition {
	return tool({
		description:
			'Show OpenHarness compatibility diagnostics: loaded plugins, enabled features, warnings, and errors.',
		args: {
			verbose: z.boolean().optional().describe('Include per-plugin details and full diagnostic messages'),
		},
		async execute(args) {
			const report = getReport()

			const lines: string[] = [
				'## OpenHarness Compatibility Diagnostics',
				'',
				`Plugins discovered: ${report.discovered}`,
				`Plugins enabled:    ${report.enabled}`,
				`Plugins blocked:    ${report.blocked}`,
				`Commands:           ${report.commands}`,
				`Agents:             ${report.agents}`,
				`Hooks:              ${report.hooks}`,
				`Skills:             ${report.skills}`,
				`MCP servers:        ${report.mcpServers}`,
				`Malformed items:    ${report.malformed}`,
				`Degraded mappings:  ${report.degraded}`,
			]

			const errors = report.diagnostics.filter(d => d.level === 'error')
			const warns = report.diagnostics.filter(d => d.level === 'warn')

			if (errors.length > 0) {
				lines.push('', `### Errors (${errors.length})`)
				for (const e of errors) {
					lines.push(`- [${e.pluginName}] ${e.message}`)
				}
			}

			if (warns.length > 0) {
				lines.push('', `### Warnings (${warns.length})`)
				for (const w of warns) {
					lines.push(`- [${w.pluginName}] ${w.message}`)
				}
			}

			if (args.verbose) {
				const plugins = getPlugins()
				if (plugins.length > 0) {
					lines.push('', '### Plugin Details')
					for (const p of plugins) {
						const status = p.blocked ? 'blocked' : p.enabled ? 'enabled' : 'disabled'
						lines.push(
							`- **${p.name}** v${p.version} (${status}, ${p.source}): ` +
								`${p.commands} cmds, ${p.agents} agents, ${p.hooks} hooks, ` +
								`${p.skills} skills, ${p.mcpServers} MCP`,
						)
					}
				}
			}

			return lines.join('\n')
		},
	})
}

export function createMemoryStatsTool(getExtraStats?: (directory: string) => Array<string>): ToolDefinition {
	return tool({
		description:
			'Show OpenHarness memory statistics for the current project: file count, total size, and recent files.',
		args: {},
		async execute(_args, ctx) {
			const memDir = getProjectMemoryDir(ctx.directory)
			if (!dirExists(memDir)) {
				const extra = getExtraStats?.(ctx.directory) ?? []
				if (extra.length === 0) return 'No memory directory found for this project.'
				return ['## Memory Statistics', '', ...extra].join('\n')
			}

			const files = listMemoryFiles(ctx.directory)
			if (!files.length) {
				return 'Memory directory exists but contains no files.'
			}

			let totalSize = 0
			const fileDetails: Array<{ name: string; size: number; modified: Date }> = []

			for (const f of files) {
				try {
					const stat = statSync(f)
					totalSize += stat.size
					fileDetails.push({
						name: f.split('/').pop() ?? f,
						size: stat.size,
						modified: stat.mtime,
					})
				} catch {
					fileDetails.push({ name: f.split('/').pop() ?? f, size: 0, modified: new Date(0) })
				}
			}

			fileDetails.sort((a, b) => b.modified.getTime() - a.modified.getTime())

			const lines: string[] = [
				'## Memory Statistics',
				'',
				`Directory: ${memDir}`,
				`Files: ${files.length}`,
				`Total size: ${formatBytes(totalSize)}`,
				'',
				'### Recent files',
			]

			const extra = getExtraStats?.(ctx.directory) ?? []
			if (extra.length > 0) {
				lines.splice(5, 0, ...extra)
			}

			for (const f of fileDetails.slice(0, 10)) {
				const age = timeAgo(f.modified)
				lines.push(`- ${f.name} (${formatBytes(f.size)}, ${age})`)
			}

			return lines.join('\n')
		},
	})
}

export function createHookLogTool(getHookLog: () => HookExecutionLog): ToolDefinition {
	return tool({
		description: 'Show OpenHarness hook execution log: recent hook executions, failures, and blocks.',
		args: {
			filter: z
				.enum(['all', 'failed', 'blocked'])
				.optional()
				.describe('Filter entries: all (default), failed, or blocked'),
		},
		async execute(args) {
			const log = getHookLog()
			const stats = log.getStats()

			const lines: string[] = [
				'## Hook Execution Log',
				'',
				`Total: ${stats.total} | Success: ${stats.success} | Failed: ${stats.failed} | Blocked: ${stats.blocked}`,
			]

			let entries: HookLogEntry[]
			switch (args.filter) {
				case 'failed':
					entries = log.getFailed()
					break
				case 'blocked':
					entries = log.getBlocked()
					break
				default:
					entries = log.getRecent(20)
			}

			if (!entries.length) {
				lines.push('', 'No matching hook executions found.')
			} else {
				lines.push('', `### Last ${entries.length} entries`)
				for (const e of entries.slice(-20)) {
					const time = new Date(e.timestamp).toISOString().slice(11, 19)
					const status = e.blocked ? 'BLOCKED' : e.success ? 'ok' : 'FAIL'
					const subj = e.subject ? ` on ${e.subject}` : ''
					const reason = e.reason ? ` — ${e.reason.slice(0, 80)}` : ''
					lines.push(`- [${time}] ${e.event} (${e.kind})${subj} ${status} (${e.durationMs}ms)${reason}`)
				}
			}

			return lines.join('\n')
		},
	})
}

export function createRuntimeStatusTool(
	getRuntimeSnapshot: (sessionID: string) => SessionRuntimeSnapshot | null,
): ToolDefinition {
	return tool({
		description: 'Show hybrid runtime status: current phase, active plan, and recent verification results.',
		args: {},
		async execute(_args, ctx) {
			const snapshot = getRuntimeSnapshot(ctx.sessionID)
			if (!snapshot) return 'No hybrid runtime state for this session.'

			const lines: string[] = ['## Hybrid Runtime Status', '', `Phase: ${getDisplayPhase(snapshot)}`]
			if (snapshot.workflow) {
				lines.push(`Workflow mode: ${snapshot.workflow.workflowMode}`)
				lines.push(`Workflow phase: ${getWorkflowPhaseLabel(snapshot.workflow.phase)}`)
				lines.push(`Allowed tools: ${snapshot.workflow.allowedTools.join(', ') || 'none'}`)
				lines.push(`Exit condition: ${snapshot.workflow.exitCondition}`)
				if (snapshot.workflow.lastTransition) lines.push(`Last transition: ${snapshot.workflow.lastTransition}`)
				if (snapshot.workflow.blockedReason) lines.push(`Blocked reason: ${snapshot.workflow.blockedReason}`)
				if (snapshot.workflow.selectedTaskIds.length > 0) {
					lines.push(`Selected tasks: ${snapshot.workflow.selectedTaskIds.join(', ')}`)
				}
				if (snapshot.workflow.verifyContract.length > 0) {
					lines.push(`Verify contract: ${snapshot.workflow.verifyContract.join(' ; ')}`)
				}
				if (snapshot.workflow.specSyncStatus) lines.push(`Spec sync: ${snapshot.workflow.specSyncStatus}`)
				if (snapshot.workflow.delegateChildren.length > 0) {
					lines.push(`Delegate children: ${snapshot.workflow.delegateChildren.join(', ')}`)
				}
				if (snapshot.workflow.recoveryState) lines.push(`Recovery state: ${snapshot.workflow.recoveryState}`)
			}
			if (snapshot.phase !== getDisplayPhase(snapshot)) lines.push(`Internal phase: ${snapshot.phase}`)
			if (snapshot.nextStep) lines.push(`Next step: ${snapshot.nextStep}`)
			if (snapshot.currentTarget) lines.push(`Current target: ${snapshot.currentTarget}`)
			if (snapshot.memoryProtocol) lines.push(`Memory protocol: ${snapshot.memoryProtocol}`)
			if (snapshot.memorySessionPointer) lines.push(`Memory session: ${snapshot.memorySessionPointer}`)
			if (snapshot.delegateSummary) lines.push(`Delegate: ${snapshot.delegateSummary}`)
			if (snapshot.commentSummary) lines.push(`Comment guardrail: ${snapshot.commentSummary}`)
			if (snapshot.doctorSummary) lines.push(`Doctor: ${snapshot.doctorSummary}`)
			if (snapshot.qualitySummary) lines.push(`Quality: ${snapshot.qualitySummary}`)
			if (snapshot.recoverySummary) lines.push(`Recovery: ${snapshot.recoverySummary}`)
			lines.push(`Elapsed: ${formatElapsed(snapshot.startedAt)}`)
			lines.push(`Updated: ${new Date(snapshot.updatedAt).toISOString()}`)
			lines.push('Composition: caveman primitive | cavekit workflow | cavemem memory | flagship runtime')
			if (snapshot.plan) {
				lines.push(`Mode: ${snapshot.plan.mode}`)
				lines.push(`Goal: ${snapshot.plan.goal}`)
				lines.push(`Active plan: ${snapshot.plan.summary}`)
				lines.push(`Task coverage: ${formatTaskCoverage(snapshot.plan)}`)
				if (snapshot.plan.sourceArtifacts.length > 0) {
					lines.push(`Sources: ${snapshot.plan.sourceArtifacts.slice(0, 6).join(', ')}`)
				}
				if (snapshot.plan.steps.length > 0) {
					lines.push('', '### Steps')
					for (const step of snapshot.plan.steps.slice(0, 5)) {
						lines.push(`- ${step.id} [${step.kind}] ${step.title}`)
					}
				}
			}

			const lastVerification = snapshot.verificationRecords.at(-1)
			if (lastVerification) {
				lines.push(`Latest validation: ${lastVerification.command} -> ${lastVerification.status}`)
			}

			if (snapshot.verificationRecords.length > 0) {
				lines.push('', '### Verification')
				for (const record of snapshot.verificationRecords.slice(-5)) {
					lines.push(`- ${record.status}: ${record.command} (${new Date(record.timestamp).toISOString()})`)
				}
			}

			lines.push('', '### L01-L04')
			lines.push(`- L01 prompt: ${formatTelemetry(snapshot.telemetry.l01Prompt)}`)
			lines.push(`- L02 tool: ${formatTelemetry(snapshot.telemetry.l02Tool)}`)
			lines.push(`- L03 output: ${formatTelemetry(snapshot.telemetry.l03Output)}`)
			lines.push(`- L04 context: ${formatTelemetry(snapshot.telemetry.l04Context)}`)
			lines.push(`- Total: ${formatTelemetrySummary(snapshot)}`)

			return lines.join('\n')
		},
	})
}

export function createTelemetrySnapshotTool(
	getRuntimeSnapshot: (sessionID: string) => SessionRuntimeSnapshot | null,
): ToolDefinition {
	return tool({
		description: 'Show L01-L04 telemetry benchmark snapshot for the current session.',
		args: {},
		async execute(_args, ctx) {
			const snapshot = getRuntimeSnapshot(ctx.sessionID)
			if (!snapshot) return 'No runtime telemetry for this session.'

			const lines: string[] = ['## Telemetry Snapshot', '']
			lines.push(`Phase: ${getDisplayPhase(snapshot)}`)
			if (snapshot.phase !== getDisplayPhase(snapshot)) lines.push(`Internal phase: ${snapshot.phase}`)
			lines.push(`Elapsed: ${formatElapsed(snapshot.startedAt)}`)
			lines.push(`Session updated: ${new Date(snapshot.updatedAt).toISOString()}`)
			if (snapshot.plan) lines.push(`Plan mode: ${snapshot.plan.mode}`)
			if (snapshot.plan) lines.push(`Task coverage: ${formatTaskCoverage(snapshot.plan)}`)
			if (snapshot.currentTarget) lines.push(`Current target: ${snapshot.currentTarget}`)
			if (snapshot.memoryProtocol) lines.push(`Memory protocol: ${snapshot.memoryProtocol}`)
			if (snapshot.memorySessionPointer) lines.push(`Memory: ${snapshot.memorySessionPointer}`)
			if (snapshot.delegateSummary) lines.push(`Delegate: ${snapshot.delegateSummary}`)
			if (snapshot.commentSummary) lines.push(`Comment guardrail: ${snapshot.commentSummary}`)
			if (snapshot.doctorSummary) lines.push(`Doctor: ${snapshot.doctorSummary}`)
			if (snapshot.qualitySummary) lines.push(`Quality: ${snapshot.qualitySummary}`)
			if (snapshot.recoverySummary) lines.push(`Recovery: ${snapshot.recoverySummary}`)
			lines.push('')
			lines.push(`L01 prompt: ${formatTelemetry(snapshot.telemetry.l01Prompt)}`)
			lines.push(`L02 tool: ${formatTelemetry(snapshot.telemetry.l02Tool)}`)
			lines.push(`L03 output: ${formatTelemetry(snapshot.telemetry.l03Output)}`)
			lines.push(`L04 context: ${formatTelemetry(snapshot.telemetry.l04Context)}`)
			lines.push(`Total: ${formatTelemetrySummary(snapshot)}`)
			return lines.join('\n')
		},
	})
}

export function createBenchmarkSnapshotTool(
	getRuntimeSnapshot: (sessionID: string) => SessionRuntimeSnapshot | null,
): ToolDefinition {
	return tool({
		description:
			'Persist a benchmark snapshot for the current session with L01-L04 telemetry and runtime metadata.',
		args: {
			write: z.boolean().optional().describe('Persist snapshot under .openharness/benchmarks (default true)'),
		},
		async execute(args, ctx) {
			const snapshot = getRuntimeSnapshot(ctx.sessionID)
			if (!snapshot) return 'No runtime benchmark snapshot for this session.'

			const benchmark = {
				sessionID: ctx.sessionID,
				phase: getDisplayPhase(snapshot),
				internalPhase: snapshot.phase,
				goal: snapshot.plan?.goal ?? snapshot.compiledPrompt?.goal ?? '',
				mode: snapshot.plan?.mode ?? 'unknown',
				taskCoverage: snapshot.plan ? formatTaskCoverage(snapshot.plan) : 'n/a',
				currentTarget: snapshot.currentTarget,
				memoryProtocol: snapshot.memoryProtocol,
				memorySessionPointer: snapshot.memorySessionPointer,
				delegateSummary: snapshot.delegateSummary ?? '',
				commentSummary: snapshot.commentSummary,
				doctorSummary: snapshot.doctorSummary,
				qualitySummary: snapshot.qualitySummary,
				recoverySummary: snapshot.recoverySummary,
				elapsedMs: Math.max(0, Date.now() - snapshot.startedAt),
				updatedAt: new Date(snapshot.updatedAt).toISOString(),
				verification: snapshot.verificationRecords.at(-1) ?? null,
				telemetry: snapshot.telemetry,
				total: formatTelemetrySummary(snapshot),
			}

			const lines = [
				'## Benchmark Snapshot',
				'',
				`Phase: ${benchmark.phase}`,
				`Goal: ${benchmark.goal || 'n/a'}`,
				`Plan mode: ${benchmark.mode}`,
				`Task coverage: ${benchmark.taskCoverage}`,
				`Current target: ${benchmark.currentTarget || 'n/a'}`,
				`Memory protocol: ${benchmark.memoryProtocol || 'n/a'}`,
				`Delegate: ${benchmark.delegateSummary || 'n/a'}`,
				`Doctor: ${benchmark.doctorSummary || 'n/a'}`,
				`Quality: ${benchmark.qualitySummary || 'n/a'}`,
				`Recovery: ${benchmark.recoverySummary || 'n/a'}`,
				`Elapsed: ${formatElapsed(snapshot.startedAt)}`,
				`L01 prompt: ${formatTelemetry(snapshot.telemetry.l01Prompt)}`,
				`L02 tool: ${formatTelemetry(snapshot.telemetry.l02Tool)}`,
				`L03 output: ${formatTelemetry(snapshot.telemetry.l03Output)}`,
				`L04 context: ${formatTelemetry(snapshot.telemetry.l04Context)}`,
				`Total: ${formatTelemetrySummary(snapshot)}`,
			]

			if (args.write !== false) {
				const outputDir = join(ctx.directory, '.openharness', 'benchmarks')
				ensureDir(outputDir)
				const outputPath = join(outputDir, `${ctx.sessionID || 'session'}-${snapshot.updatedAt}.json`)
				writeFileAtomic(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`)
				lines.splice(2, 0, `File: ${outputPath}`)
			}

			return lines.join('\n')
		},
	})
}

function formatTelemetry(layer: SessionRuntimeSnapshot['telemetry']['l01Prompt']): string {
	const toolModes = formatToolCompressionModes(layer)
	if (layer.sampleCount === 0) return toolModes ? `not observed; ${toolModes}` : 'not observed'
	const percent = layer.baselineChars > 0 ? ((layer.savedChars / layer.baselineChars) * 100).toFixed(1) : '0.0'
	const summary = `baseline ${layer.baselineChars} -> ${layer.compressedChars} chars (~${estimateTokens(layer.baselineChars)} -> ~${estimateTokens(layer.compressedChars)} tok), saved ${layer.savedChars} (${percent}%), samples ${layer.sampleCount}, last ${layer.lastBaselineChars} -> ${layer.lastCompressedChars}`
	return toolModes ? `${summary}; ${toolModes}` : summary
}

function formatToolCompressionModes(layer: SessionRuntimeSnapshot['telemetry']['l01Prompt']): string {
	if (!isToolCompressionLayer(layer)) return ''
	const parts: string[] = []
	if (layer.rewrittenCount > 0) parts.push(`rewritten ${layer.rewrittenCount}`)
	if (layer.skippedCount > 0) parts.push(`skipped ${layer.skippedCount}`)
	if (layer.proxiedCount > 0) parts.push(`proxied ${layer.proxiedCount}`)
	if (layer.unavailableCount > 0) parts.push(`unavailable ${layer.unavailableCount}`)
	if (layer.lastMode) {
		parts.push(layer.lastReason ? `last ${layer.lastMode} (${layer.lastReason})` : `last ${layer.lastMode}`)
	}
	return parts.join(', ')
}

function isToolCompressionLayer(
	layer: SessionRuntimeSnapshot['telemetry']['l01Prompt'],
): layer is SessionRuntimeSnapshot['telemetry']['l02Tool'] {
	return (
		'rewrittenCount' in layer &&
		typeof layer.rewrittenCount === 'number' &&
		'skippedCount' in layer &&
		typeof layer.skippedCount === 'number' &&
		'proxiedCount' in layer &&
		typeof layer.proxiedCount === 'number' &&
		'unavailableCount' in layer &&
		typeof layer.unavailableCount === 'number' &&
		'lastMode' in layer &&
		'lastReason' in layer
	)
}

export function formatTelemetrySummary(snapshot: SessionRuntimeSnapshot): string {
	const layers = [
		snapshot.telemetry.l01Prompt,
		snapshot.telemetry.l02Tool,
		snapshot.telemetry.l03Output,
		snapshot.telemetry.l04Context,
	]
	const baseline = layers.reduce((sum, layer) => sum + layer.baselineChars, 0)
	const compressed = layers.reduce((sum, layer) => sum + layer.compressedChars, 0)
	const saved = layers.reduce((sum, layer) => sum + layer.savedChars, 0)
	const samples = layers.reduce((sum, layer) => sum + layer.sampleCount, 0)
	if (samples === 0) return 'not observed'
	const percent = baseline > 0 ? ((saved / baseline) * 100).toFixed(1) : '0.0'
	return `baseline ${baseline} -> ${compressed} chars (~${estimateTokens(baseline)} -> ~${estimateTokens(compressed)} tok), saved ${saved} (${percent}%), samples ${samples}`
}

function formatTaskCoverage(snapshot: SessionRuntimeSnapshot['plan']): string {
	if (!snapshot) return 'n/a'
	const verify = snapshot.steps.filter(step => step.kind === 'verify').length
	const edit = snapshot.steps.filter(step => step.kind === 'edit').length
	const inspect = snapshot.steps.filter(step => step.kind === 'inspect').length
	return `${snapshot.steps.length} steps (${inspect} inspect, ${edit} edit, ${verify} verify)`
}

function getDisplayPhase(snapshot: SessionRuntimeSnapshot): string {
	if (snapshot.workflow?.workflowMode === 'strict') return getWorkflowPhaseLabel(snapshot.workflow.phase)
	const lastVerification = snapshot.verificationRecords.at(-1)
	if (snapshot.phase === 'verify' && lastVerification?.status === 'pass') return 'done'
	if (snapshot.phase === 'load-context') return 'load context'
	if (snapshot.phase === 'compile-prompt') return 'compile prompt'
	if (snapshot.phase === 'run-tests') return 'run/tests'
	return snapshot.phase
}

function formatElapsed(startedAt: number): string {
	const elapsedMs = Math.max(0, Date.now() - startedAt)
	const totalSeconds = Math.floor(elapsedMs / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function estimateTokens(chars: number): number {
	return Math.max(0, Math.ceil(chars / 4))
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function timeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
	if (seconds < 60) return `${seconds}s ago`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
	return `${Math.floor(seconds / 86400)}d ago`
}
