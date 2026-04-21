import type { Config } from '@opencode-ai/plugin'
import type { LoadedCompatPlugin, PluginDiagnostic } from '../shared/types.js'

const BUILTIN_COMMANDS: Record<string, { template: string; description: string }> = {
	caveman: {
		description: 'Switch Caveman mode: full, lite, or ultra',
		template: [
			'Activate caveman mode for this session.',
			'If `$ARGUMENTS` is `lite`, use lite mode. If `$ARGUMENTS` is `ultra`, use ultra mode. Otherwise use full mode.',
			'Keep this mode active every response until the user says `stop caveman` or `normal mode`.',
		].join(' '),
	},
	'caveman-help': {
		description: 'Show Caveman modes and commands',
		template: [
			'Display a quick Caveman help card.',
			'Include modes: lite, full, ultra.',
			'Include commands: `/caveman`, `/caveman-help`, `/caveman-stack`, `/caveman-status`, `/caveman-memory`, `/caveman-backprop`, `/caveman-commit`, `/caveman-review`, `/ck-spec`, `/ck-build`, `/ck-check`.',
			'Explain that `full` is default, `/caveman ultra` switches intensity, and `stop caveman` or `normal mode` disables it for the session.',
			'Explain that `/caveman-stack` uses Caveman compression + CaveKit planning + CaveMem recall as one hybrid loop.',
			'One-shot help only. Do not change the current mode unless the user explicitly asked to switch mode.',
			'Write the help card in terse Caveman style.',
		].join(' '),
	},
	'caveman-stack': {
		description: 'Run full Caveman stack workflow',
		template: [
			'Use the full Caveman stack for this task.',
			'Load and compress long-lived context from `CLAUDE.md`, `AGENTS.md`, `SPEC.md`, and rules before acting.',
			'Use CaveMem recall for relevant prior prompts, tool history, and mirrored memory notes.',
			'If `SPEC.md` exists, use CaveKit spec-driven planning. Otherwise use hybrid ad-hoc planning.',
			'Proceed through phases: load context -> compile prompt -> plan -> edit -> run/tests -> verify.',
			'If verification fails in spec-driven mode, backprop to `§B BUGS` and `§V INVARIANTS` before continuing.',
			'Treat `$ARGUMENTS` as the task objective or scope override.',
		].join(' '),
	},
	'caveman-status': {
		description: 'Show current Caveman stack runtime status',
		template: [
			'Show the current Caveman stack runtime state for this session.',
			'Report current phase, active plan mode, plan summary, next steps, and latest verification results.',
			'Prefer using the runtime status tool if available and summarize the result tersely.',
			'No code edits. Status only.',
		].join(' '),
	},
	'caveman-memory': {
		description: 'Recall relevant CaveMem and memory context',
		template: [
			'Recall task-relevant memory before acting.',
			'Use both OpenHarness memory files and CaveMem-backed session memory for the current project.',
			'Summarize only the observations that change planning, editing, or verification decisions.',
			'Treat `$ARGUMENTS` as the recall query or focus area.',
		].join(' '),
	},
	'caveman-backprop': {
		description: 'Backprop latest failure into CaveKit spec',
		template: [
			'Inspect the latest failed or flaky verification and backprop it into `SPEC.md` when the project uses CaveKit.',
			'Update `§B BUGS`, strengthen `§V INVARIANTS`, and keep `§T TASKS` status honest.',
			'If no spec exists, explain the failure and propose the invariant that should exist instead of inventing a spec unasked.',
			'Treat `$ARGUMENTS` as an optional failure focus, command, or subsystem.',
		].join(' '),
	},
	'caveman-commit': {
		description: 'Generate terse Conventional Commit message',
		template: [
			'Write a terse Conventional Commit message for the current changes.',
			'Use format `<type>(<scope>): <imperative summary>` with optional scope.',
			'Subject should be <=50 chars when possible, never over 72, no trailing period.',
			'Prefer why over what. Add body only when the why is not obvious, for breaking changes, migrations, or security context.',
			'Do not run git commands. Only output the commit message in a fenced code block ready to paste.',
		].join(' '),
	},
	'caveman-review': {
		description: 'Generate terse code review comments',
		template: [
			'Review the current diff or code under discussion with terse, actionable comments.',
			'Write one line per finding in format `L<line>: <problem>. <fix>.` or `<file>:L<line>: ...` for multi-file context.',
			'Use severity prefixes when helpful: `🔴 bug:`, `🟡 risk:`, `🔵 nit:`, `❓ q:`.',
			'No throat-clearing, no praise padding, no hedging. Keep exact symbol names and concrete fixes.',
			'Output comments only, ready to paste into a PR review.',
		].join(' '),
	},
	'ck-spec': {
		description: 'Create or amend a CaveKit SPEC.md',
		template: [
			'Read or create repo-root `SPEC.md` using CaveKit v4 structure: `§G GOAL`, `§C CONSTRAINTS`, `§I INTERFACES`, `§V INVARIANTS`, `§T TASKS`, `§B BUGS`.',
			'Treat `$ARGUMENTS` as the requested scope, goal, or amendment.',
			'Keep fixed section order, one-file rule, and CaveKit-style caveman compression for spec prose while preserving code, paths, identifiers, URLs, numbers, and exact errors verbatim.',
			'If `SPEC.md` exists, update only the sections that changed and keep task ids monotonic.',
			'If new bugs or regressions are discovered, append them under `§B` and add or tighten invariants in `§V`.',
		].join(' '),
	},
	'ck-build': {
		description: 'Implement the next CaveKit SPEC.md task',
		template: [
			'Read repo-root `SPEC.md` first.',
			'Select the next unfinished or in-progress task from `§T TASKS`, implement the minimal correct diff, and keep work aligned with cited interfaces and invariants.',
			'Update task state as work progresses: `.` -> `~` -> `x` only when the task is actually complete and verified.',
			'If validation fails, backprop the failure into `§B BUGS` and add the missing guardrail in `§V INVARIANTS` before continuing.',
			'Treat `$ARGUMENTS` as an optional task selector, scope, or constraint override.',
		].join(' '),
	},
	'ck-check': {
		description: 'Compare the repo against CaveKit SPEC.md',
		template: [
			'Read repo-root `SPEC.md` and perform a read-only drift check.',
			'Compare current code and behavior against `§I INTERFACES`, `§V INVARIANTS`, and `§T TASKS`.',
			'Report violations and gaps with exact section references like `§V.2` or task ids like `T3`.',
			'Treat `$ARGUMENTS` as an optional focus area, file path, or subsystem to check first.',
			'Do not edit files unless the user explicitly asks for fixes after the report.',
		].join(' '),
	},
}

export function injectIntoConfig(
	config: Config,
	plugins: LoadedCompatPlugin[],
	enabledOnly: boolean = true,
): PluginDiagnostic[] {
	const diagnostics: PluginDiagnostic[] = []
	injectBuiltInCommands(config)

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

function injectBuiltInCommands(config: Config): void {
	if (!config.command) config.command = {}

	for (const [name, command] of Object.entries(BUILTIN_COMMANDS)) {
		if (config.command[name]) continue
		config.command[name] = command
	}
}

function sanitizeCommandName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}

function sanitizeAgentName(name: string): string {
	return name.replace(/:/g, '-').toLowerCase()
}
