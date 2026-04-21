import type { Config } from '@opencode-ai/plugin'
import type { LoadedCompatPlugin, PluginDiagnostic } from '../shared/types.js'
import { buildCompatibilityReport } from './discovery.js'

export function injectIntoConfig(
	config: Config,
	plugins: LoadedCompatPlugin[],
	enabledOnly: boolean = true,
): PluginDiagnostic[] {
	const diagnostics: PluginDiagnostic[] = []

	const active = enabledOnly ? plugins.filter(p => p.enabled) : plugins

	for (const plugin of active) {
		for (const cmd of plugin.commands) {
			const key = sanitizeCommandName(cmd.name)
			if (!config.command) config.command = {}
			if (config.command![key]) {
				diagnostics.push({
					level: 'warn',
					pluginName: plugin.manifest.name,
					message: `Command '${key}' already exists, skipping`,
				})
				continue
			}
			config.command![key] = {
				template: cmd.template,
				description: cmd.description,
				...(cmd.model ? { model: cmd.model } : {}),
				...(cmd.agent ? { agent: cmd.agent } : {}),
			}
		}

		for (const agent of plugin.agents) {
			const key = sanitizeAgentName(agent.name)
			if (!config.agent) config.agent = {}
			if (config.agent![key]) {
				diagnostics.push({
					level: 'warn',
					pluginName: plugin.manifest.name,
					message: `Agent '${key}' already exists, skipping`,
				})
				continue
			}
			config.agent![key] = {
				description: agent.description,
				prompt: agent.prompt,
				mode: agent.mode,
				...(agent.model ? { model: agent.model } : {}),
				...(agent.color ? { color: agent.color } : {}),
				...(agent.temperature != null ? { temperature: agent.temperature } : {}),
				...(agent.steps ? { steps: agent.steps } : {}),
			}
		}

		if (Object.keys(plugin.mcpServers).length > 0) {
			if (!config.mcp) config.mcp = {}
			for (const [name, server] of Object.entries(plugin.mcpServers)) {
				const key = `${plugin.manifest.name}__${name}`
				if ((config.mcp as Record<string, unknown>)![key]) {
					diagnostics.push({
						level: 'warn',
						pluginName: plugin.manifest.name,
						message: `MCP server '${key}' already exists, skipping`,
					})
					continue
				}
				;(config.mcp as Record<string, unknown>)![key] = server
			}
		}
	}

	return diagnostics
}

function sanitizeCommandName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}

function sanitizeAgentName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}
