import type { LoadedCompatPlugin, CompatibilityReport } from '../shared/types.js'
import { buildCompatibilityReport } from './discovery.js'

export function formatReport(report: CompatibilityReport): string {
	const lines: string[] = [
		'OpenHarness Compatibility Report',
		'================================',
		`Discovered: ${report.discovered} plugins`,
		`Loaded:     ${report.loaded} plugins`,
		`Enabled:    ${report.enabled} plugins`,
		`Blocked:    ${report.blocked} plugins`,
		'',
		`Commands:   ${report.commands}`,
		`Agents:     ${report.agents}`,
		`Hooks:      ${report.hooks}`,
		`Skills:     ${report.skills}`,
		`MCP:        ${report.mcpServers} servers`,
		`Malformed:  ${report.malformed}`,
		`Degraded:   ${report.degraded}`,
	]

	if (report.diagnostics.length > 0) {
		lines.push('')
		lines.push('Diagnostics:')
		for (const d of report.diagnostics) {
			const prefix = d.level === 'error' ? 'ERROR' : d.level === 'warn' ? 'WARN ' : 'INFO '
			lines.push(`  [${prefix}] ${d.pluginName}: ${d.message}${d.detail ? ` (${d.detail})` : ''}`)
		}
	}

	return lines.join('\n')
}

export { buildCompatibilityReport }
