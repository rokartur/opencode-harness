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
import {
	discoverExtraContext,
	discoverClaudeRules,
	discoverRootContext,
	ContextArtifactCache,
} from './context/index.js'
import {
	buildCavemanSystemPrompt,
	compressForCaveman,
	detectCavemanDirective,
	type CavemanMode,
} from './context/caveman.js'
import {
	SessionStateTracker,
	buildCompactionContext,
	formatCompactionAttachments,
	truncateCompactionContext,
} from './context/compaction.js'
import {
	createMemoryTools,
	findRelevantProjectMemories,
	startCaveMemSession,
	endCaveMemSession,
	recordCaveMemUserPrompt,
	recordCaveMemToolUse,
	recordCaveMemSessionSummary,
	countCaveMemProjectObservations,
} from './memory/index.js'
import {
	HookExecutionLog,
	createDiagnosticsTool,
	createMemoryStatsTool,
	createHookLogTool,
	createRuntimeStatusTool,
} from './tui.js'
import { tool as toolFn } from '@opencode-ai/plugin'
import {
	compileUserPrompt,
	buildExecutionPlan,
	renderExecutionPlan,
	summarizeExecutionPlan,
	SessionRuntimeTracker,
} from './runtime/index.js'
import { classifyVerification } from './runtime/verifier.js'
import { applyVerificationToSpec } from './runtime/backprop.js'
import type { PluginConfig, CompatHook, LoadedCompatPlugin } from './shared/types.js'
import { injectCavememMcp, isCavememAvailable } from './shared/cavemem.js'
import { isRtkAvailable, rewriteCommandWithRtk } from './shared/rtk.js'

const z = toolFn.schema

export const OpenHarnessCompatPlugin: Plugin = async (input, options) => {
	const cavemanMode = normalizeCavemanMode(options?.cavemanMode)
	const cavememBinary =
		typeof options?.cavememBinary === 'string' && options.cavememBinary.trim()
			? options.cavememBinary.trim()
			: 'cavemem'
	const rtkBinary =
		typeof options?.rtkBinary === 'string' && options.rtkBinary.trim() ? options.rtkBinary.trim() : 'rtk'

	const config: PluginConfig = {
		allowProjectPlugins: options?.allowProjectPlugins === true,
		extraPluginRoots: options?.extraPluginRoots as string[] | undefined,
		namespaceMode: 'full',
		enableHooks: options?.enableHooks !== false,
		enableMemory: options?.enableMemory !== false,
		enableCompaction: options?.enableCompaction !== false,
		enableClaudeRulesCompat: options?.enableClaudeRulesCompat !== false,
		enableClaudeMdContext: options?.enableClaudeMdContext !== false,
		enableAgentsMdContext: options?.enableAgentsMdContext !== false,
		enableCavekitSpecContext: options?.enableCavekitSpecContext !== false,
		enableContextArtifactCompression: options?.enableContextArtifactCompression !== false,
		enableIssueContext: options?.enableIssueContext !== false,
		enablePrCommentsContext: options?.enablePrCommentsContext !== false,
		enableActiveRepoContext: options?.enableActiveRepoContext !== false,
		enableCavemanInputCompression: options?.enableCavemanInputCompression === true,
		enableCavemanOutputCompression: options?.enableCavemanOutputCompression !== false,
		cavemanMode,
		enableCavememBridge: options?.enableCavememBridge !== false,
		enableCavememMcp: options?.enableCavememMcp !== false,
		cavememBinary,
		cavememDataDir: typeof options?.cavememDataDir === 'string' ? options.cavememDataDir : undefined,
		enableRtk: options?.enableRtk === true,
		rtkBinary,
	}

	const cavememAvailable = config.enableCavememMcp ? isCavememAvailable(cavememBinary) : false
	const rtkAvailable = config.enableRtk ? isRtkAvailable(rtkBinary) : false

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

	if (config.enableRtk && !rtkAvailable) {
		await input.client.app.log({
			body: {
				service: 'opencode-harness',
				level: 'warn',
				message: `RTK enabled but binary '${rtkBinary}' is unavailable. Bash rewrite disabled.`,
			},
		})
	}

	if (config.enableCavememMcp && !cavememAvailable) {
		await input.client.app.log({
			body: {
				service: 'opencode-harness',
				level: 'warn',
				message: `CaveMem MCP enabled but binary '${cavememBinary}' is unavailable. Native CaveMem MCP disabled.`,
			},
		})
	}

	const allHooks = plugins.filter(p => p.enabled).flatMap(p => p.hooks)

	const allSkills = plugins.filter(p => p.enabled).flatMap(p => p.skills)

	const sessionStateBySession = new Map<string, SessionStateTracker>()
	const sessionRuntimeBySession = new Map<string, SessionRuntimeTracker>()
	const invokedSkillsBySession = new Map<string, Set<string>>()
	const cavemanStateBySession = new Map<string, { enabled: boolean; mode: CavemanMode }>()
	const persistentHookContextBySession = new Map<string, string[]>()
	const promptHookContextBySession = new Map<string, string[]>()
	const hookLog = new HookExecutionLog()
	const contextArtifacts = new ContextArtifactCache()
	const memoryTools = createMemoryTools({
		cavemem: {
			enabled: config.enableCavememBridge !== false,
			dataDir: config.cavememDataDir,
			resolveMode: sessionID => getCavemanState(sessionID).mode,
		},
	})

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

	function getSessionRuntime(sessionID: string): SessionRuntimeTracker {
		const existing = sessionRuntimeBySession.get(sessionID)
		if (existing) return existing
		const created = new SessionRuntimeTracker()
		sessionRuntimeBySession.set(sessionID, created)
		trimSessionCache(sessionRuntimeBySession, MAX_SESSION_CACHE)
		return created
	}

	function getInvokedSkills(sessionID: string): string[] {
		return Array.from(invokedSkillsBySession.get(sessionID) ?? [])
	}

	function getCavemanState(sessionID?: string): { enabled: boolean; mode: CavemanMode } {
		if (!sessionID) {
			return {
				enabled: config.enableCavemanOutputCompression !== false,
				mode: config.cavemanMode ?? 'full',
			}
		}

		const existing = cavemanStateBySession.get(sessionID)
		if (existing) return existing

		const created = {
			enabled: config.enableCavemanOutputCompression !== false,
			mode: config.cavemanMode ?? 'full',
		}
		cavemanStateBySession.set(sessionID, created)
		trimSessionCache(cavemanStateBySession, MAX_SESSION_CACHE)
		return created
	}

	function updateCavemanState(sessionID: string, next: Partial<{ enabled: boolean; mode: CavemanMode }>): void {
		const current = getCavemanState(sessionID)
		cavemanStateBySession.set(sessionID, {
			enabled: next.enabled ?? current.enabled,
			mode: next.mode ?? current.mode,
		})
		trimSessionCache(cavemanStateBySession, MAX_SESSION_CACHE)
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
		sessionRuntimeBySession.delete(sessionID)
		invokedSkillsBySession.delete(sessionID)
		cavemanStateBySession.delete(sessionID)
		persistentHookContextBySession.delete(sessionID)
		promptHookContextBySession.delete(sessionID)
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
	): Promise<{ blocked: boolean; results: Array<{ kind: CompatHook['kind']; success: boolean; output: string }> }> {
		const hooks = findMatchingHooks(openCodeEvent, subject)
		let blocked = false
		const results: Array<{ kind: CompatHook['kind']; success: boolean; output: string }> = []

		for (const hook of hooks) {
			const start = Date.now()
			const result = await executeHook(hook, payload, cwd)
			const durationMs = Date.now() - start
			results.push({ kind: hook.kind, success: result.success, output: result.output })
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

	function setHookContext(cache: Map<string, string[]>, sessionID: string, outputs: string[]): void {
		if (outputs.length === 0) {
			cache.delete(sessionID)
			return
		}
		cache.set(sessionID, outputs)
		trimSessionCache(cache, MAX_SESSION_CACHE)
	}

	function rememberHookContext(sessionID: string, outputs: string[]): void {
		if (outputs.length === 0) return
		const merged = new Set([...(persistentHookContextBySession.get(sessionID) ?? []), ...outputs])
		persistentHookContextBySession.set(sessionID, Array.from(merged))
		trimSessionCache(persistentHookContextBySession, MAX_SESSION_CACHE)
	}

	return {
		config: async cfg => {
			const diagnostics = injectIntoConfig(cfg, plugins)
			if (config.enableCavememMcp && cavememAvailable) {
				injectCavememMcp(cfg, cavememBinary)
			}
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
			...(config.enableMemory ? memoryTools : {}),
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
			openharness_memory_stats: createMemoryStatsTool(directory => {
				if (config.enableCavememBridge === false) return []
				return [
					`CaveMem observations: ${countCaveMemProjectObservations(directory, { dataDir: config.cavememDataDir })}`,
				]
			}),
			openharness_hook_log: createHookLogTool(() => hookLog),
			openharness_runtime_status: createRuntimeStatusTool(sessionID => {
				if (!sessionID) return null
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_caveman_stack_status: createRuntimeStatusTool(sessionID => {
				if (!sessionID) return null
				return getSessionRuntime(sessionID).snapshot()
			}),
		},

		'tool.execute.before':
			config.enableHooks || config.enableRtk
				? async (hookInput, output) => {
						if (config.enableHooks) {
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

						if (config.enableRtk && rtkAvailable && hookInput.tool === 'bash') {
							const command = typeof output.args?.command === 'string' ? output.args.command : ''
							if (command) {
								const rewritten = rewriteCommandWithRtk(command, rtkBinary)
								if (rewritten !== command) {
									output.args = { ...(output.args ?? {}), command: rewritten }
								}
							}
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
			if (config.enableCavememBridge !== false) {
				recordCaveMemToolUse(hookInput.sessionID, cwd, hookInput.tool, hookInput.args, toolOutput, {
					dataDir: config.cavememDataDir,
					mode: getCavemanState(hookInput.sessionID).mode,
				})
			}
			const sessionState = getSessionState(hookInput.sessionID)
			const sessionRuntime = getSessionRuntime(hookInput.sessionID)
			sessionRuntime.noteTool(hookInput.tool, hookInput.args)
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
			const verification = classifyVerification({
				tool: hookInput.tool,
				args: hookInput.args ?? {},
				output: { output: toolOutput.output, metadata: toolOutput.metadata },
			})
			if (verification) {
				sessionRuntime.noteVerification(verification)
				applyVerificationToSpec(sessionRuntime.snapshot().plan, verification)
			}
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
				const runtimeSnapshot = getSessionRuntime(hookInput.sessionID).snapshot()
				const ctx = buildCompactionContext({
					cwd,
					lastPrompt: getLastPrompt(lastPromptBySession, hookInput.sessionID),
					plugins,
					invokedSkills: getInvokedSkills(hookInput.sessionID),
					sessionState: getSessionState(hookInput.sessionID),
					executionPlanSummary: runtimeSnapshot.plan ? summarizeExecutionPlan(runtimeSnapshot.plan) : '',
					executionPhase: runtimeSnapshot.phase,
					runtimeVerification: runtimeSnapshot.verificationSummary,
					includeCavemem: config.enableCavememBridge !== false,
					cavememDataDir: config.cavememDataDir,
				})
				const formatted = formatCompactionAttachments(ctx)
				if (formatted) {
					output.context.push(truncateCompactionContext(formatted))
				}
			}
		},

		'experimental.chat.system.transform': async (_input, output) => {
			const sessionID = _input.sessionID
			const cavemanState = getCavemanState(sessionID)
			const runtimeSnapshot = sessionID ? getSessionRuntime(sessionID).snapshot() : null
			if (cavemanState.enabled) {
				output.system.push(buildCavemanSystemPrompt(cavemanState.mode))
			}

			const hookContext = sessionID
				? [
						...(persistentHookContextBySession.get(sessionID) ?? []),
						...(promptHookContextBySession.get(sessionID) ?? []),
					]
				: []
			if (sessionID && hookContext.length > 0) {
				output.system.push(`# OpenHarness Hook Context\n\n${hookContext.join('\n\n')}`)
				promptHookContextBySession.delete(sessionID)
			}

			const extraContexts = discoverExtraContext(cwd, {
				issue: config.enableIssueContext !== false,
				prComments: config.enablePrCommentsContext !== false,
				activeRepo: config.enableActiveRepoContext !== false,
			})
			const rootContext = discoverRootContext(cwd, {
				claudeMd: config.enableClaudeMdContext !== false,
				agentsMd: config.enableAgentsMdContext !== false,
				spec: config.enableCavekitSpecContext !== false,
			})
			const claudeRules = config.enableClaudeRulesCompat ? discoverClaudeRules(cwd) : []

			const allContext = [...rootContext, ...extraContexts, ...claudeRules]

			if (runtimeSnapshot?.plan) {
				output.system.push(renderExecutionPlan(runtimeSnapshot.plan, runtimeSnapshot.phase))
			}

			if (config.enableMemory) {
				const lastPrompt = getLastPrompt(lastPromptBySession, sessionID)
				if (lastPrompt) {
					const memories = findRelevantProjectMemories(lastPrompt, cwd, 3, {
						includeCavemem: config.enableCavememBridge !== false,
						cavememDataDir: config.cavememDataDir,
					})
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

			const compiledContext =
				config.enableContextArtifactCompression !== false
					? contextArtifacts.compileAll(allContext, cavemanState.mode)
					: allContext.map(ctx => ({
							...ctx,
							compressed: false,
							originalChars: ctx.content.length,
							artifactChars: ctx.content.length,
						}))

			const section = compiledContext
				.map(ctx => {
					const heading = ctx.compressed ? `${ctx.label} [cave artifact]` : ctx.label
					return `## ${heading}\n\`\`\`md\n${ctx.content}\n\`\`\``
				})
				.join('\n\n')

			output.system.push(`# OpenHarness Compatibility Context\n\n${section}`)
		},

		'experimental.chat.messages.transform': async (_input, output) => {
			if (!config.enableCavemanInputCompression) return
			const sessionID =
				typeof (_input as { sessionID?: string }).sessionID === 'string'
					? (_input as { sessionID?: string }).sessionID
					: undefined
			const cavemanState = getCavemanState(sessionID)
			if (!cavemanState.enabled) return

			for (const message of output.messages) {
				if (message.info.role !== 'user') continue
				for (const part of message.parts) {
					if (part.type === 'text') {
						part.text = compressForCaveman(part.text, cavemanState.mode)
					}
					if (part.type === 'subtask') {
						part.prompt = compressForCaveman(part.prompt, cavemanState.mode)
					}
				}
			}
		},

		'experimental.text.complete': async (_input, output) => {
			const cavemanState = getCavemanState(_input.sessionID)
			if (!cavemanState.enabled) return
			output.text = compressForCaveman(output.text, cavemanState.mode)
		},

		'chat.message': async (hookInput, output) => {
			const prompt = extractUserPrompt(output.parts)
			const sessionRuntime = getSessionRuntime(hookInput.sessionID)
			const directive = detectCavemanDirective(prompt)
			if (directive) {
				updateCavemanState(hookInput.sessionID, directive)
			}
			if (config.enableHooks) {
				const { results } = await runMatchingHooks(
					'chat.message',
					{
						prompt,
						session_id: hookInput.sessionID,
						message_id: hookInput.messageID,
					},
					prompt,
				)
				setHookContext(promptHookContextBySession, hookInput.sessionID, collectHookContext(results))
			}
			if (prompt) {
				sessionRuntime.setPhase('compile-prompt')
				if (config.enableCavememBridge !== false) {
					recordCaveMemUserPrompt(hookInput.sessionID, cwd, prompt, {
						dataDir: config.cavememDataDir,
						mode: getCavemanState(hookInput.sessionID).mode,
					})
				}
				setLastPrompt(hookInput.sessionID, prompt)
				const compiledPrompt = compileUserPrompt(prompt)
				sessionRuntime.setCompiledPrompt(compiledPrompt)
				const planningRootContext = discoverRootContext(cwd, {
					claudeMd: config.enableClaudeMdContext !== false,
					agentsMd: config.enableAgentsMdContext !== false,
					spec: config.enableCavekitSpecContext !== false,
				})
				const planningMemories = config.enableMemory
					? findRelevantProjectMemories(prompt, cwd, 3, {
							includeCavemem: config.enableCavememBridge !== false,
							cavememDataDir: config.cavememDataDir,
						})
					: []
				const sessionState = getSessionState(hookInput.sessionID)
				const plan = buildExecutionPlan({
					compiledPrompt,
					rootContext: planningRootContext,
					memories: planningMemories,
					taskFocus: sessionState.getTaskFocus(),
				})
				sessionRuntime.setPlan(plan)
				sessionState.updateGoal(plan.goal)
				sessionState.setNextStep(plan.steps[0]?.title ?? 'Apply next planned step and verify result.')
			} else if (hookInput.messageID) {
				getSessionState(hookInput.sessionID)
				getSessionRuntime(hookInput.sessionID)
			}
		},

		event: async ({ event }) => {
			const type = event.type as string
			const sessionId = extractSessionId(event)
			if (config.enableCavememBridge !== false && type === 'session.created' && sessionId) {
				startCaveMemSession(sessionId, cwd, {
					dataDir: config.cavememDataDir,
					mode: getCavemanState(sessionId).mode,
				})
			}
			if (type === 'session.created' && sessionId) {
				getSessionRuntime(sessionId).setPhase('load-context')
			}

			if (config.enableHooks) {
				if (type === 'session.created' && sessionId) {
					const { results } = await runMatchingHooks('session.created', { session_id: sessionId })
					rememberHookContext(sessionId, collectHookContext(results))
				}
				if (type === 'session.compacted' && sessionId) {
					const { results } = await runMatchingHooks('session.compacted', { session_id: sessionId })
					rememberHookContext(sessionId, collectHookContext(results))
				}
				if (type === 'session.deleted' && sessionId) {
					await runMatchingHooks('session.deleted', { session_id: sessionId })
				}
			}

			if (type === 'session.deleted' && sessionId) {
				if (config.enableCavememBridge !== false) {
					const summary = buildSessionSummary(
						getSessionState(sessionId),
						getLastPrompt(lastPromptBySession, sessionId),
					)
					if (summary) {
						recordCaveMemSessionSummary(sessionId, cwd, summary, {
							dataDir: config.cavememDataDir,
							mode: getCavemanState(sessionId).mode,
						})
					}
					endCaveMemSession(sessionId, { dataDir: config.cavememDataDir })
				}
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

function collectHookContext(results: Array<{ kind: CompatHook['kind']; success: boolean; output: string }>): string[] {
	const context: string[] = []
	for (const result of results) {
		if (!result.success) continue
		for (const entry of extractHookContext(result.output)) {
			if (!context.includes(entry)) context.push(entry)
		}
	}
	return context
}

function extractHookContext(output: string): string[] {
	const trimmed = output.trim()
	if (!trimmed) return []

	const parsed = tryParseJson(trimmed)
	const structured = collectStructuredHookContext(parsed)
	if (structured.length > 0) return structured

	return [trimmed]
}

function collectStructuredHookContext(parsed: unknown): string[] {
	if (!parsed || typeof parsed !== 'object') return []
	const record = parsed as Record<string, unknown>
	const context: string[] = []
	const hookSpecific =
		typeof record.hookSpecificOutput === 'object' && record.hookSpecificOutput != null
			? (record.hookSpecificOutput as Record<string, unknown>)
			: null

	const additionalContext =
		(typeof hookSpecific?.additionalContext === 'string' && hookSpecific.additionalContext) ||
		(typeof record.additionalContext === 'string' && record.additionalContext) ||
		(typeof record.prompt === 'string' && record.prompt) ||
		''

	if (additionalContext.trim()) context.push(additionalContext.trim())

	return context
}

function tryParseJson(input: string): unknown {
	if (!/^[\[{]/.test(input)) return null
	try {
		return JSON.parse(input)
	} catch {
		return null
	}
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

function buildSessionSummary(sessionState: SessionStateTracker, lastPrompt: string): string {
	const focus = sessionState.getTaskFocus()
	const lines: string[] = []
	if (lastPrompt) lines.push(`Last prompt: ${truncateStr(lastPrompt, 240)}`)
	if (focus.goal) lines.push(`Goal: ${truncateStr(focus.goal, 240)}`)
	if (focus.nextStep) lines.push(`Next step: ${truncateStr(focus.nextStep, 240)}`)
	if (focus.activeArtifacts.length > 0) lines.push(`Artifacts: ${focus.activeArtifacts.slice(-5).join(', ')}`)
	if (focus.verifiedState.length > 0) lines.push(`Verified: ${focus.verifiedState.slice(-3).join('; ')}`)
	const recentWork = sessionState.getRecentWorkLog().slice(-3)
	if (recentWork.length > 0) lines.push(`Recent work: ${recentWork.join(' | ')}`)
	return lines.join('\n')
}

function normalizeCavemanMode(raw: unknown): CavemanMode {
	if (raw === 'lite' || raw === 'full' || raw === 'ultra') return raw
	return 'full'
}
