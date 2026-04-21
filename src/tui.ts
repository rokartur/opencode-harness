import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import { listMemoryFiles } from './memory/manager.js'
import { getProjectMemoryDir } from './memory/paths.js'
import { dirExists } from './shared/fs.js'
import { statSync } from 'node:fs'
import type { CompatibilityReport } from './shared/types.js'
import type { SessionRuntimeSnapshot } from './runtime/index.js'

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

			const lines: string[] = ['## Hybrid Runtime Status', '', `Phase: ${snapshot.phase}`]
			if (snapshot.plan) {
				lines.push(`Mode: ${snapshot.plan.mode}`)
				lines.push(`Goal: ${snapshot.plan.goal}`)
				lines.push(`Summary: ${snapshot.plan.summary}`)
				if (snapshot.plan.steps.length > 0) {
					lines.push('', '### Steps')
					for (const step of snapshot.plan.steps.slice(0, 5)) {
						lines.push(`- ${step.id} [${step.kind}] ${step.title}`)
					}
				}
			}

			if (snapshot.verificationRecords.length > 0) {
				lines.push('', '### Verification')
				for (const record of snapshot.verificationRecords.slice(-5)) {
					lines.push(`- ${record.status}: ${record.command}`)
				}
			}

			return lines.join('\n')
		},
	})
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
