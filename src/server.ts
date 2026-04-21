import type { Plugin } from '@opencode-ai/plugin'
import {
	discoverPluginRoots,
	discoverPluginDirs,
	loadPluginsFromDirs,
	injectIntoConfig,
	buildCompatibilityReport,
	formatReport,
} from './compat/index.js'
import { executeHook, matchesHook, mapOpenHarnessEventToOpenCode } from './compat/hooks-executor.js'
import { discoverExtraContext, discoverClaudeRules } from './context/index.js'
import {
	SessionStateTracker,
	buildCompactionContext,
	formatCompactionAttachments,
	truncateCompactionContext,
} from './context/compaction.js'
import {
	memoryListTool,
	memoryReadTool,
	memorySearchTool,
	memoryWriteTool,
	memoryDeleteTool,
	memoryIndexTool,
	findRelevantMemories,
} from './memory/index.js'
import { HookExecutionLog, createDiagnosticsTool, createMemoryStatsTool, createHookLogTool } from './tui.js'
import { tool as toolFn } from '@opencode-ai/plugin'
import type { PluginConfig, CompatHook, LoadedCompatPlugin } from './shared/types.js'

const z = toolFn.schema

export const OpenHarnessCompatPlugin: Plugin = async (input, options) => {
	const config: PluginConfig = {
		allowProjectPlugins: options?.allowProjectPlugins === true,
		extraPluginRoots: options?.extraPluginRoots as string[] | undefined,
		namespaceMode: 'full',
		enableHooks: options?.enableHooks !== false,
		enableMemory: options?.enableMemory !== false,
		enableCompaction: options?.enableCompaction !== false,
		enableClaudeRulesCompat: options?.enableClaudeRulesCompat !== false,
		enableIssueContext: options?.enableIssueContext !== false,
		enablePrCommentsContext: options?.enablePrCommentsContext !== false,
		enableActiveRepoContext: options?.enableActiveRepoContext !== false,
	}

	const cwd = input.directory
	const roots = discoverPluginRoots(cwd, config)
	const pluginDirs = discoverPluginDirs(roots)
	const plugins = loadPluginsFromDirs(pluginDirs, config, cwd)
	const report = buildCompatibilityReport(plugins)

	if (report.diagnostics.length > 0 || report.discovered > 0) {
		await input.client.app.log({
			body: {
				service: 'opencode-harness',
				level: 'info',
				message: formatReport(report),
			},
		})
	}

	if (options?.namespaceMode === 'short') {
		await input.client.app.log({
			body: {
				service: 'opencode-harness',
				level: 'warn',
				message: "'namespaceMode=short' is deprecated and ignored; full namespacing is always used.",
			},
		})
	}

	const allHooks = plugins.filter(p => p.enabled).flatMap(p => p.hooks)

	const allSkills = plugins.filter(p => p.enabled).flatMap(p => p.skills)

	const sessionStateBySession = new Map<string, SessionStateTracker>()
	const invokedSkillsBySession = new Map<string, Set<string>>()
	const hookLog = new HookExecutionLog()

	const lastPromptBySession = new Map<string, string>()
	const MAX_SESSION_CACHE = 50

	function getSessionState(sessionID: string): SessionStateTracker {
		const existing = sessionStateBySession.get(sessionID)
		if (existing) return existing
		const created = new SessionStateTracker()
		sessionStateBySession.set(sessionID, created)
		trimSessionCache(sessionStateBySession, MAX_SESSION_CACHE)
		return created
	}

	function getInvokedSkills(sessionID: string): string[] {
		return Array.from(invokedSkillsBySession.get(sessionID) ?? [])
	}

	function recordInvokedSkill(sessionID: string, skillName: string): void {
		const existing = invokedSkillsBySession.get(sessionID) ?? new Set<string>()
		existing.add(skillName)
		invokedSkillsBySession.set(sessionID, existing)
		trimSessionCache(invokedSkillsBySession, MAX_SESSION_CACHE)
	}

	function setLastPrompt(sessionID: string, prompt: string): void {
		if (!prompt.trim()) return
		if (lastPromptBySession.has(sessionID)) lastPromptBySession.delete(sessionID)
		lastPromptBySession.set(sessionID, prompt.trim())
		trimSessionCache(lastPromptBySession, MAX_SESSION_CACHE)
		const sessionState = getSessionState(sessionID)
		sessionState.updateGoal(prompt.trim())
		sessionState.setNextStep('Continue the active task and verify the result.')
	}

	function clearSession(sessionID: string): void {
		lastPromptBySession.delete(sessionID)
		sessionStateBySession.delete(sessionID)
		invokedSkillsBySession.delete(sessionID)
	}

	function findMatchingHooks(openCodeEvent: string, subject?: string): CompatHook[] {
		const matched: CompatHook[] = []
		for (const hook of allHooks) {
			const targets = mapOpenHarnessEventToOpenCode(hook.event)
			if (!targets.includes(openCodeEvent)) continue
			if (subject && hook.matcher && !matchesHook(hook, subject)) continue
			matched.push(hook)
		}
		return matched
	}

	async function runMatchingHooks(
		openCodeEvent: string,
		payload: Record<string, unknown>,
		subject?: string,
	): Promise<{ blocked: boolean; results: Array<{ success: boolean; output: string }> }> {
		const hooks = findMatchingHooks(openCodeEvent, subject)
		let blocked = false
		const results: Array<{ success: boolean; output: string }> = []

		for (const hook of hooks) {
			const start = Date.now()
			const result = await executeHook(hook, payload, cwd)
			const durationMs = Date.now() - start
			results.push({ success: result.success, output: result.output })
			hookLog.record({
				event: hook.event,
				kind: hook.kind,
				success: result.success,
				blocked: result.blocked,
				durationMs,
				subject: (payload.tool_name as string) || undefined,
				reason: result.reason,
			})
			if (result.blocked) {
				blocked = true
				break
			}
		}

		return { blocked, results }
	}

	return {
		config: async cfg => {
			const diagnostics = injectIntoConfig(cfg, plugins)
			for (const d of diagnostics) {
				await input.client.app.log({
					body: {
						service: 'opencode-harness',
						level: d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : 'info',
						message: `[${d.pluginName}] ${d.message}`,
					},
				})
			}
		},

		tool: {
			...(config.enableMemory
				? {
						openharness_memory_list: memoryListTool,
						openharness_memory_read: memoryReadTool,
						openharness_memory_search: memorySearchTool,
						openharness_memory_write: memoryWriteTool,
						openharness_memory_delete: memoryDeleteTool,
						openharness_memory_index: memoryIndexTool,
					}
				: {}),
			...(allSkills.length > 0
				? {
						openharness_skill: toolFn({
							description: `Load a skill from OpenHarness compatibility plugins. Available: ${allSkills.map(s => s.name).join(', ')}`,
							args: { name: z.string().describe('Name of the skill to load') },
							async execute(args: { name: string }, ctx) {
								const skill = allSkills.find(s => s.name.toLowerCase() === args.name.toLowerCase())
								if (!skill)
									return `Skill '${args.name}' not found. Available: ${allSkills.map(s => s.name).join(', ')}`
								recordInvokedSkill(ctx.sessionID, skill.name)
								return skill.content
							},
						}),
					}
				: {}),
			openharness_diagnostics: createDiagnosticsTool(
				() => buildCompatibilityReport(plugins),
				() =>
					plugins.map(p => ({
						name: p.manifest.name,
						version: p.manifest.version,
						source: p.source,
						enabled: p.enabled,
						blocked: p.blockedByPolicy === true,
						commands: p.commands.length,
						agents: p.agents.length,
						hooks: p.hooks.length,
						skills: p.skills.length,
						mcpServers: Object.keys(p.mcpServers).length,
					})),
			),
			openharness_memory_stats: createMemoryStatsTool(),
			openharness_hook_log: createHookLogTool(() => hookLog),
		},

		'tool.execute.before': config.enableHooks
			? async (hookInput, output) => {
					const subject = hookInput.tool
					const { blocked } = await runMatchingHooks(
						'tool.execute.before',
						{
							tool_name: hookInput.tool,
							session_id: hookInput.sessionID,
							call_id: hookInput.callID,
						},
						subject,
					)
					if (blocked) {
						throw new Error(`Blocked by OpenHarness hook for tool '${hookInput.tool}'`)
					}
				}
			: undefined,

		'tool.execute.after': async (hookInput, toolOutput) => {
			if (config.enableHooks) {
				await runMatchingHooks('tool.execute.after', {
					tool_name: hookInput.tool,
					session_id: hookInput.sessionID,
					call_id: hookInput.callID,
					args: hookInput.args,
				})
			}
			const sessionState = getSessionState(hookInput.sessionID)
			sessionState.addWorkLogEntry(
				`${hookInput.tool}${hookInput.args ? `: ${truncateStr(JSON.stringify(hookInput.args), 80)}` : ''}`,
			)
			if (hookInput.tool === 'read' || hookInput.tool === 'glob') {
				const path =
					typeof hookInput.args?.filePath === 'string'
						? hookInput.args.filePath
						: typeof hookInput.args?.pattern === 'string'
							? hookInput.args.pattern
							: ''
				if (path) sessionState.addArtifact(path)
			}
			maybeRecordVerificationState(sessionState, hookInput, toolOutput)
			maybeSetNextStep(sessionState, hookInput)
		},

		'experimental.session.compacting': async (hookInput, output) => {
			if (config.enableHooks) {
				const { blocked } = await runMatchingHooks('experimental.session.compacting', {
					session_id: hookInput.sessionID,
				})
				if (blocked) {
					throw new Error('Compaction blocked by OpenHarness pre_compact hook')
				}
			}

			if (config.enableCompaction) {
				const ctx = buildCompactionContext({
					cwd,
					lastPrompt: getLastPrompt(lastPromptBySession, hookInput.sessionID),
					plugins,
					invokedSkills: getInvokedSkills(hookInput.sessionID),
					sessionState: getSessionState(hookInput.sessionID),
				})
				const formatted = formatCompactionAttachments(ctx)
				if (formatted) {
					output.context.push(truncateCompactionContext(formatted))
				}
			}
		},

		'experimental.chat.system.transform': async (_input, output) => {
			const sessionID = _input.sessionID
			const extraContexts = discoverExtraContext(cwd, {
				issue: config.enableIssueContext !== false,
				prComments: config.enablePrCommentsContext !== false,
				activeRepo: config.enableActiveRepoContext !== false,
			})
			const claudeRules = config.enableClaudeRulesCompat ? discoverClaudeRules(cwd) : []

			const allContext = [...extraContexts, ...claudeRules]

			if (config.enableMemory) {
				const lastPrompt = getLastPrompt(lastPromptBySession, sessionID)
				if (lastPrompt) {
					const memories = findRelevantMemories(lastPrompt, cwd, 3)
					for (const mem of memories) {
						allContext.push({
							label: `Memory: ${mem.title}`,
							content: mem.bodyPreview,
							source: mem.path,
						})
					}
				}
			}

			if (allContext.length === 0) return

			const section = allContext.map(ctx => `## ${ctx.label}\n\`\`\`md\n${ctx.content}\n\`\`\``).join('\n\n')

			output.system.push(`# OpenHarness Compatibility Context\n\n${section}`)
		},

		'chat.message': async (hookInput, output) => {
			const prompt = extractUserPrompt(output.parts)
			if (prompt) {
				setLastPrompt(hookInput.sessionID, prompt)
			} else if (hookInput.messageID) {
				getSessionState(hookInput.sessionID)
			}
		},

		event: async ({ event }) => {
			const type = event.type as string
			const sessionId = extractSessionId(event)

			if (config.enableHooks) {
				if (type === 'session.created' && sessionId) {
					await runMatchingHooks('session.created', { session_id: sessionId })
				}
				if (type === 'session.compacted' && sessionId) {
					await runMatchingHooks('session.compacted', { session_id: sessionId })
				}
				if (type === 'session.deleted' && sessionId) {
					await runMatchingHooks('session.deleted', { session_id: sessionId })
				}
			}

			if (type === 'session.deleted' && sessionId) {
				clearSession(sessionId)
			}
		},
	}
}

function getLastPrompt(cache: Map<string, string>, sessionID?: string): string {
	if (!sessionID) return ''
	return cache.get(sessionID) ?? ''
}

function truncateStr(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + '...'
}

function extractSessionId(event: Record<string, unknown>): string | undefined {
	const direct = event.sessionID ?? event.session_id ?? event.id
	if (typeof direct === 'string') return direct

	const properties = event.properties
	if (!properties || typeof properties !== 'object') return undefined

	const props = properties as Record<string, unknown>
	if (typeof props.sessionID === 'string') return props.sessionID
	if (typeof props.session_id === 'string') return props.session_id

	const info = props.info
	if (info && typeof info === 'object' && typeof (info as Record<string, unknown>).id === 'string') {
		return (info as Record<string, unknown>).id as string
	}

	return undefined
}

function trimSessionCache<T>(cache: Map<string, T>, maxEntries: number = 50): void {
	while (cache.size > maxEntries) {
		const oldest = cache.keys().next().value
		if (!oldest) return
		cache.delete(oldest)
	}
}

function extractUserPrompt(parts: Array<Record<string, unknown>>): string {
	const text = parts
		.map(part => {
			if (part.type === 'text' && typeof part.text === 'string') return part.text
			if (part.type === 'subtask' && typeof part.prompt === 'string') return part.prompt
			return ''
		})
		.filter(Boolean)
		.join('\n')
		.trim()

	return text
}

function maybeRecordVerificationState(
	sessionState: SessionStateTracker,
	hookInput: { tool: string; args: any },
	toolOutput: { title: string; output: string; metadata: any },
): void {
	if (hookInput.tool !== 'bash') return
	const command = typeof hookInput.args?.command === 'string' ? hookInput.args.command : ''
	if (!command) return

	const exitCode = typeof toolOutput.metadata?.exitCode === 'number' ? toolOutput.metadata.exitCode : 0
	if (exitCode !== 0) return

	const normalized = command.toLowerCase()
	if (/\b(test|build|typecheck|check|lint)\b/.test(normalized)) {
		sessionState.addVerifiedState(`Verified: ${truncateStr(command, 100)}`)
		sessionState.setNextStep('Summarize the verified work or continue with the next change.')
	}
}

function maybeSetNextStep(sessionState: SessionStateTracker, hookInput: { tool: string; args: any }): void {
	if (hookInput.tool === 'read' || hookInput.tool === 'glob') {
		sessionState.setNextStep('Apply the change informed by the latest files and then verify it.')
		return
	}

	if (hookInput.tool === 'openharness_skill') {
		sessionState.setNextStep('Use the loaded compatibility skill while continuing the current task.')
	}
}
