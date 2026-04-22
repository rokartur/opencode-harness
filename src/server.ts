import type { Plugin } from '@opencode-ai/plugin'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { relative, resolve } from 'node:path'
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
import { CAVEMAN_FILE_MODES, compressContextFile } from './context/compress-file.js'
import {
	SessionStateTracker,
	buildCompactionContext,
	formatCompactionAttachments,
	truncateCompactionContext,
} from './context/compaction.js'
import {
	createMemoryTools,
	createCaveMemInspectTools,
	findRelevantMemories,
	findRelevantProjectMemories,
	resolveCaveMemSettings,
	startCaveMemSession,
	endCaveMemSession,
	recordCaveMemUserPrompt,
	recordCaveMemToolUse,
	recordCaveMemAssistantStop,
	recordCaveMemSessionSummary,
	reindexCaveMemProject,
	countCaveMemProjectObservations,
	listCaveMemSessions,
	getCaveMemTimeline,
	getCaveMemObservations,
	hydrateCaveMemSearchResults,
	hydrateCaveMemSearchResultsViaMcp,
	getCaveMemObservationsByIdsViaMcp,
	getCaveMemTimelineViaMcp,
	listCaveMemSessionsViaMcp,
	reindexCaveMemProjectViaMcp,
	searchCaveMemProject,
	searchCaveMemProjectViaMcp,
	type MemoryHeader,
} from './memory/index.js'
import {
	HookExecutionLog,
	createDiagnosticsTool,
	createMemoryStatsTool,
	createHookLogTool,
	createRuntimeStatusTool,
	createTelemetrySnapshotTool,
	createBenchmarkSnapshotTool,
	formatTelemetrySummary,
} from './tui.js'
import { tool as toolFn } from '@opencode-ai/plugin'
import {
	compileUserPrompt,
	buildExecutionPlan,
	buildCaveKitPlan,
	checkCaveKitDrift,
	renderExecutionPlan,
	resolveCaveKitSpecPath,
	summarizeExecutionPlan,
	SessionRuntimeTracker,
	upsertCaveKitSpec,
} from './runtime/index.js'
import { classifyVerification, combineVerificationRecords, createVerificationRecord } from './runtime/verifier.js'
import { applyVerificationToSpec } from './runtime/backprop.js'
import type { PluginConfig, CompatHook, LoadedCompatPlugin } from './shared/types.js'
import { injectCavememMcp, isCavememAvailable } from './shared/cavemem.js'
import { isRtkAvailable, resolveRtkCommandCompression } from './shared/rtk.js'
import { writeFileAtomic } from './shared/fs.js'

const z = toolFn.schema

export const OpenHarnessCompatPlugin: Plugin = async (input, options) => {
	const cavemanMode = normalizeCavemanMode(options?.cavemanMode)
	const cavememSettings = resolveCaveMemSettings(options as Partial<PluginConfig>)
	const cavememBinary =
		typeof options?.cavememBinary === 'string' && options.cavememBinary.trim()
			? options.cavememBinary.trim()
			: 'cavemem'
	const cavekitMutatorMode =
		options?.cavekitMutatorMode === 'strict-upstream' ? 'strict-upstream' : 'opencode-integrated'
	const rtkBinary =
		typeof options?.rtkBinary === 'string' && options.rtkBinary.trim() ? options.rtkBinary.trim() : 'rtk'
	const rtkFallbackMode = options?.rtkFallbackMode === 'proxy' ? 'proxy' : 'passthrough'

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
		cavekitMutatorMode,
		cavemem: options?.cavemem as PluginConfig['cavemem'],
		cavememBinary,
		cavememDataDir: cavememSettings.dataDir,
		enableRtk: options?.enableRtk === true,
		rtkBinary,
		rtkFallbackMode,
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
				message: `RTK enabled but binary '${rtkBinary}' is unavailable. L02 rewrite unavailable; commands pass through unchanged.`,
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
			defaultLimit: cavememSettings.searchDefaultLimit,
			searchAlpha: cavememSettings.searchAlpha,
			embeddingProvider: cavememSettings.embeddingProvider,
			resolveMode: sessionID => getCavemanState(sessionID).mode,
			resolveOptions: sessionID => getCaveMemRuntimeOptions(sessionID),
		},
		searchProjectMemories: async ({ query, directory, sessionID, limit }) =>
			await recallProjectMemories(query, directory, sessionID, limit),
	})
	const cavememInspectTools =
		config.enableCavememBridge !== false && (!config.enableCavememMcp || !cavememAvailable)
			? createCaveMemInspectTools({
					dataDir: config.cavememDataDir,
					defaultLimit: cavememSettings.searchDefaultLimit,
					searchAlpha: cavememSettings.searchAlpha,
					embeddingProvider: cavememSettings.embeddingProvider,
				})
			: {}

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

	function setSessionNextStep(sessionID: string, nextStep: string): void {
		const normalized = nextStep.trim()
		getSessionState(sessionID).setNextStep(normalized)
		getSessionRuntime(sessionID).setNextStep(normalized)
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

	function getCaveMemRuntimeOptions(sessionID?: string) {
		return {
			dataDir: config.cavememDataDir,
			mode: cavememSettings.compressionIntensity ?? getCavemanState(sessionID).mode,
			redactPrivateTags: cavememSettings.redactPrivateTags,
			excludePathPatterns: cavememSettings.excludePathPatterns,
			expandForModel: cavememSettings.expandForModel,
			embeddingProvider: cavememSettings.embeddingProvider,
			searchAlpha: cavememSettings.searchAlpha,
			searchDefaultLimit: cavememSettings.searchDefaultLimit,
		}
	}

	function describeMemoryProtocol(): string {
		if (config.enableCavememMcp && cavememAvailable) return 'cavemem mcp primary; local bridge fallback'
		if (config.enableCavememBridge !== false) return 'cavemem local bridge fallback tools'
		return 'memory disabled'
	}

	function markMemoryProtocol(sessionID: string | undefined, protocol: string): void {
		if (!sessionID) return
		getSessionRuntime(sessionID).setMemoryProtocol(protocol)
	}

	async function searchCavememMemory(
		query: string,
		directory: string,
		sessionID: string | undefined,
		limit: number,
	): Promise<Array<MemoryHeader & { score: number }>> {
		if (config.enableCavememMcp && cavememAvailable) {
			const results = await searchCaveMemProjectViaMcp(
				{ query, cwd: directory, limit },
				{ binary: cavememBinary, dataDir: config.cavememDataDir },
			)
			if (results) {
				markMemoryProtocol(sessionID, 'cavemem mcp active; local bridge standby')
				return results
			}
		}
		if (config.enableCavememBridge === false) return []
		markMemoryProtocol(sessionID, 'cavemem local bridge fallback tools')
		return searchCaveMemProject(query, directory, limit, getCaveMemRuntimeOptions(sessionID))
	}

	async function hydrateCavememMemory(
		results: Array<MemoryHeader & { score: number }>,
		directory: string,
		sessionID: string | undefined,
		maxResults: number,
	): Promise<Array<MemoryHeader & { score: number }>> {
		if (results.length === 0) return []
		if (config.enableCavememMcp && cavememAvailable) {
			const hydrated = await hydrateCaveMemSearchResultsViaMcp(
				results,
				{ ids: [], cwd: directory },
				{ binary: cavememBinary, dataDir: config.cavememDataDir },
				maxResults,
			)
			if (hydrated) {
				markMemoryProtocol(sessionID, 'cavemem mcp active; local bridge standby')
				return hydrated
			}
		}
		return hydrateCaveMemSearchResults(results, directory, getCaveMemRuntimeOptions(sessionID), maxResults)
	}

	async function recallProjectMemories(
		query: string,
		directory: string,
		sessionID: string | undefined,
		limit: number,
	): Promise<MemoryHeader[]> {
		if (!query.trim()) return []
		const markdownMemories = config.enableMemory ? findRelevantMemories(query, directory, Math.min(limit, 3)) : []
		const cavememIndex = await searchCavememMemory(query, directory, sessionID, limit * 2)
		const cavememHydrated = await hydrateCavememMemory(cavememIndex, directory, sessionID, limit)
		return mergeMemoryRecall(markdownMemories, cavememHydrated, limit)
	}

	function mergeMemoryRecall(
		markdown: MemoryHeader[],
		cavemem: Array<MemoryHeader & { score: number }>,
		limit: number,
	): MemoryHeader[] {
		const merged = new Map<string, MemoryHeader>()
		for (const entry of cavemem) {
			merged.set(entry.path, entry)
		}
		for (const entry of markdown) {
			if (merged.has(entry.path)) continue
			merged.set(entry.path, entry)
		}
		return Array.from(merged.values())
			.sort((left, right) => {
				const leftPriority = left.memoryType.startsWith('cavemem:') ? 1 : 0
				const rightPriority = right.memoryType.startsWith('cavemem:') ? 1 : 0
				return rightPriority - leftPriority || right.modifiedAt - left.modifiedAt
			})
			.slice(0, limit)
	}

	function runVerificationCommands(
		directory: string,
		commands: string[],
		timeoutMs: number = 120_000,
	): {
		records: ReturnType<typeof createVerificationRecord>[]
		combined: ReturnType<typeof combineVerificationRecords>
	} {
		const records = commands.map(command => {
			const result = spawnSync('sh', ['-lc', command], {
				cwd: directory,
				encoding: 'utf-8',
				timeout: timeoutMs,
			})
			const body = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
			const exitCode = typeof result.status === 'number' ? result.status : null
			return createVerificationRecord(command, body, exitCode)
		})
		return { records, combined: combineVerificationRecords(records) }
	}

	function applyBuildFileEdits(
		directory: string,
		writeFiles: Array<{ path: string; content: string }> = [],
		deleteFiles: string[] = [],
	): { written: string[]; deleted: string[] } {
		const written: string[] = []
		const deleted: string[] = []
		for (const entry of writeFiles) {
			const targetPath = resolveRepoLocalPath(directory, entry.path)
			writeFileAtomic(targetPath, entry.content)
			written.push(toDisplayPath(directory, targetPath))
		}
		for (const entry of deleteFiles) {
			const targetPath = resolveRepoLocalPath(directory, entry)
			rmSync(targetPath, { force: true, recursive: true })
			deleted.push(toDisplayPath(directory, targetPath))
		}
		return { written, deleted }
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
		setSessionNextStep(sessionID, 'Continue the active task and verify the result.')
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
			...cavememInspectTools,
			openharness_cavemem_recall: toolFn({
				description:
					'Canonical CaveMem recall surface for project memory, sessions, timeline, and observations.',
				args: {
					query: z.string().optional().describe('Recall query for task-relevant memory'),
					mode: z
						.enum(['search', 'timeline', 'observations', 'sessions', 'reindex'])
						.optional()
						.describe('Canonical CaveMem inspect mode'),
					limit: z.number().optional().describe('Optional result limit'),
				},
				async execute(args, ctx) {
					const mode = args.mode ?? (args.query?.trim() ? 'search' : 'timeline')
					const limit = args.limit ?? cavememSettings.searchDefaultLimit
					const lines = ['## CaveMem', '', `Protocol: ${describeMemoryProtocol()}`]
					if (config.enableCavememMcp && cavememAvailable) {
						lines.push('Native MCP: available')
					}
					if (mode === 'sessions') {
						const sessions =
							config.enableCavememMcp && cavememAvailable
								? ((await listCaveMemSessionsViaMcp(
										{ cwd: ctx.directory, limit },
										{ binary: cavememBinary, dataDir: config.cavememDataDir },
									)) ??
									listCaveMemSessions(ctx.directory, limit, getCaveMemRuntimeOptions(ctx.sessionID)))
								: listCaveMemSessions(ctx.directory, limit, getCaveMemRuntimeOptions(ctx.sessionID))
						if (sessions.length === 0) return [...lines, '', 'No CaveMem sessions.'].join('\n')
						lines.push('', '### Sessions')
						for (const session of sessions) {
							lines.push(`- ${session.sessionID} obs=${session.observationCount}`)
						}
						return lines.join('\n')
					}
					if (mode === 'observations') {
						const query =
							args.query?.trim() || getLastPrompt(lastPromptBySession, ctx.sessionID) || 'recent work'
						const observations =
							config.enableCavememMcp && cavememAvailable
								? ((await getCaveMemObservationsByIdsViaMcp(
										{
											ids: (
												await searchCavememMemory(query, ctx.directory, ctx.sessionID, limit)
											)
												.slice(0, limit)
												.map(memory => Number(memory.path.split('/').pop() ?? 0))
												.filter(value => Number.isFinite(value) && value > 0),
											cwd: ctx.directory,
										},
										{ binary: cavememBinary, dataDir: config.cavememDataDir },
									)) ??
									getCaveMemObservations({
										sessionID: ctx.sessionID,
										cwd: ctx.directory,
										maxResults: limit,
										options: getCaveMemRuntimeOptions(ctx.sessionID),
									}))
								: getCaveMemObservations({
										sessionID: ctx.sessionID,
										cwd: ctx.directory,
										maxResults: limit,
										options: getCaveMemRuntimeOptions(ctx.sessionID),
									})
						if (observations.length === 0) return [...lines, '', 'No CaveMem observations.'].join('\n')
						lines.push('', '### Observations')
						for (const observation of observations) {
							lines.push(
								`- [${observation.event}] ${observation.content.replace(/\s+/g, ' ').slice(0, 160)}`,
							)
						}
						return lines.join('\n')
					}
					if (mode === 'reindex') {
						const reindex =
							config.enableCavememMcp && cavememAvailable
								? ((await reindexCaveMemProjectViaMcp(
										{ cwd: ctx.directory },
										{ binary: cavememBinary, dataDir: config.cavememDataDir },
									)) ?? reindexCaveMemProject(ctx.directory, getCaveMemRuntimeOptions(ctx.sessionID)))
								: reindexCaveMemProject(ctx.directory, getCaveMemRuntimeOptions(ctx.sessionID))
						lines.push(
							'',
							`Reindex: provider=${reindex.provider} scanned=${reindex.scanned} updated=${reindex.updated}`,
						)
						return lines.join('\n')
					}
					if (mode === 'timeline') {
						const query =
							args.query?.trim() || getLastPrompt(lastPromptBySession, ctx.sessionID) || 'recent work'
						const timeline =
							config.enableCavememMcp && cavememAvailable
								? ((await getCaveMemTimelineViaMcp(
										{ query, cwd: ctx.directory, limit },
										{ binary: cavememBinary, dataDir: config.cavememDataDir },
									)) ??
									getCaveMemTimeline(ctx.directory, limit, getCaveMemRuntimeOptions(ctx.sessionID)))
								: getCaveMemTimeline(ctx.directory, limit, getCaveMemRuntimeOptions(ctx.sessionID))
						if (timeline.length === 0) return [...lines, '', 'No CaveMem timeline entries.'].join('\n')
						lines.push('', '### Timeline')
						for (const entry of timeline) {
							lines.push(
								`- ${entry.sessionID} ${entry.event} ${entry.content.replace(/\s+/g, ' ').slice(0, 160)}`,
							)
						}
						return lines.join('\n')
					}
					const query =
						args.query?.trim() || getLastPrompt(lastPromptBySession, ctx.sessionID) || 'recent work'
					const cavememIndex = await searchCavememMemory(query, ctx.directory, ctx.sessionID, limit)
					const cavememDetails = await hydrateCavememMemory(
						cavememIndex,
						ctx.directory,
						ctx.sessionID,
						Math.min(limit, 3),
					)
					const markdownMemories = findRelevantMemories(query, ctx.directory, Math.min(limit, 3))
					if (cavememIndex.length === 0 && markdownMemories.length === 0)
						return [...lines, '', `Query: ${query}`, '', 'No relevant CaveMem recall.'].join('\n')
					lines.push('', `Query: ${query}`)
					if (cavememIndex.length > 0) {
						lines.push('', '### MCP Search Index')
						for (const memory of cavememIndex) {
							lines.push(`- ${memory.title} (${memory.path}) ${memory.description}`)
						}
					}
					if (cavememDetails.length > 0) {
						lines.push('', '### Hydrated Observations')
						for (const memory of cavememDetails) {
							lines.push(`- ${memory.title} (${memory.memoryType}) ${memory.bodyPreview}`)
						}
					}
					if (markdownMemories.length > 0) {
						lines.push('', '### Markdown Memory')
						for (const memory of markdownMemories) {
							lines.push(`- ${memory.title} (${memory.memoryType}) ${memory.description}`)
						}
					}
					return lines.join('\n')
				},
			}),
			openharness_cavekit_spec: toolFn({
				description: 'Create or amend repo-root SPEC.md as the canonical CaveKit workflow artifact.',
				args: {
					scope: z.string().optional().describe('Freeform scope or amendment request'),
					goal: z.string().optional().describe('Optional explicit goal override'),
					constraints: z.array(z.string()).optional().describe('Optional constraint lines'),
					interfaces: z.array(z.string()).optional().describe('Optional interface lines'),
					invariants: z.array(z.string()).optional().describe('Optional invariant lines'),
					tasks: z.array(z.string()).optional().describe('Optional task descriptions'),
					bugs: z.array(z.string()).optional().describe('Optional bug notes to append'),
				},
				async execute(args, ctx) {
					const result = upsertCaveKitSpec(ctx.directory, args)
					return [
						`Path: ${toDisplayPath(ctx.directory, result.path)}`,
						`Created: ${result.created ? 'yes' : 'no'}`,
						`Changed: ${result.changed ? 'yes' : 'no'}`,
						`Goal: ${result.goal}`,
						`Task coverage: ${result.taskCoverage}`,
						`Verify: ${result.validationCommands.join(' ; ') || 'n/a'}`,
					].join('\n')
				},
			}),
			openharness_cavekit_build: toolFn({
				description:
					'Select the next CaveKit task(s), mark active work in SPEC.md, and return the canonical build plan.',
				args: {
					selector: z.string().optional().describe('Task selector: ., ~, x, or task ids like T1,T2'),
					focus: z.string().optional().describe('Optional focus to rank tasks'),
					limit: z.number().optional().describe('Optional task limit'),
					markActive: z
						.boolean()
						.optional()
						.describe('Mark selected pending tasks as active (~). Defaults true.'),
					runVerify: z
						.boolean()
						.optional()
						.describe('Run inferred validation commands directly. Defaults true.'),
					verifyTimeoutMs: z
						.number()
						.optional()
						.describe('Timeout per validation command in milliseconds. Defaults 120000.'),
					writeFiles: z
						.array(z.object({ path: z.string(), content: z.string() }))
						.optional()
						.describe('Optional repo-local file writes to execute before verification.'),
					deleteFiles: z
						.array(z.string())
						.optional()
						.describe('Optional repo-local file paths to delete before verification.'),
					syncLatestVerification: z
						.boolean()
						.optional()
						.describe('Apply the latest session verification to selected tasks. Defaults true.'),
				},
				async execute(args, ctx) {
					const result = buildCaveKitPlan(ctx.directory, {
						selector: args.selector,
						focus: args.focus,
						limit: args.limit,
						markActive: args.markActive !== false,
					})
					const runtime = getSessionRuntime(ctx.sessionID)
					const firstTask = result.selectedTasks[0]
					if (firstTask) {
						runtime.setCurrentTarget(firstTask.task)
						runtime.setNextStep(
							`Implement ${firstTask.id} and verify with ${result.validationCommands.join(' + ') || 'project checks'}.`,
						)
					}
					const executedEdits = applyBuildFileEdits(
						ctx.directory,
						args.writeFiles ?? [],
						args.deleteFiles ?? [],
					)
					if (executedEdits.written.length > 0 || executedEdits.deleted.length > 0) {
						runtime.setPhase('edit')
						const executedTargets = [...executedEdits.written, ...executedEdits.deleted]
						runtime.setCurrentTarget(executedTargets[0] ?? firstTask?.task ?? '')
					}
					let verification: ReturnType<typeof combineVerificationRecords> | null = null
					let verificationDetails = 'none'
					if ((args.runVerify ?? true) && result.validationCommands.length > 0) {
						runtime.setPhase('run-tests')
						const executed = runVerificationCommands(
							ctx.directory,
							result.validationCommands,
							args.verifyTimeoutMs ?? 120_000,
						)
						verification = executed.combined
						verificationDetails = executed.records
							.map(record => `${record.command} -> ${record.status}`)
							.join(' | ')
					} else {
						const latestVerification = runtime.snapshot().verificationRecords.at(-1) ?? null
						verification = args.syncLatestVerification === false ? null : latestVerification
						verificationDetails = verification
							? `${verification.command} -> ${verification.status}`
							: 'none'
					}
					if (verification) runtime.noteVerification(verification)
					const verificationSynced =
						verification && result.selectedTasks.length > 0
							? applyVerificationToSpec(
									{
										mode: 'spec-driven',
										goal: result.goal,
										summary: 'CaveKit build verification sync.',
										steps: result.selectedTasks.map(task => ({
											id: task.id,
											kind: 'edit',
											title: task.task,
											reason: 'Sync explicit build verification to SPEC.md.',
											citations: task.cites,
											acceptance: result.validationCommands.map(command => `Run ${command}`),
										})),
										sourceArtifacts: ['CaveKit Spec'],
										specSource: result.path,
										memoryRefs: [],
										validationCommands: result.validationCommands,
									},
									verification,
								)
							: false
					return [
						`Path: ${toDisplayPath(ctx.directory, result.path)}`,
						`Goal: ${result.goal}`,
						`Task coverage: ${result.taskCoverage}`,
						`Changed: ${result.changed ? 'yes' : 'no'}`,
						`Executed writes: ${executedEdits.written.join(', ') || 'none'}`,
						`Executed deletes: ${executedEdits.deleted.join(', ') || 'none'}`,
						`Verification sync: ${verificationDetails}`,
						`Backprop applied: ${verificationSynced ? 'yes' : 'no'}`,
						`Selected: ${result.selectedTasks.map(task => `${task.id}[${task.status}] ${task.task}`).join(' | ') || 'none'}`,
						`Verify: ${result.validationCommands.join(' ; ') || 'n/a'}`,
					].join('\n')
				},
			}),
			openharness_cavekit_check: toolFn({
				description: 'Perform a deterministic read-only CaveKit drift report against SPEC.md.',
				args: {
					focus: z.string().optional().describe('Optional subsystem or file focus'),
				},
				async execute(args, ctx) {
					const result = checkCaveKitDrift(ctx.directory, args.focus)
					const lines = [
						'## CaveKit Check',
						'',
						`Path: ${toDisplayPath(ctx.directory, result.path)}`,
						`Goal: ${result.goal}`,
						`Task coverage: ${result.taskCoverage}`,
						`Verify: ${result.validationCommands.join(' ; ') || 'n/a'}`,
						'',
						'### Findings',
					]
					for (const finding of result.findings) {
						lines.push(`- ${finding.severity.toUpperCase()} ${finding.reference}: ${finding.message}`)
					}
					return lines.join('\n')
				},
			}),
			openharness_cavekit_backprop: toolFn({
				description: 'Backprop the latest failed/flaky verification into SPEC.md using CaveKit semantics.',
				args: {
					command: z.string().optional().describe('Optional explicit verification command override'),
					status: z
						.enum(['pass', 'fail', 'flaky', 'unknown'])
						.optional()
						.describe('Optional explicit verification status override'),
					summary: z.string().optional().describe('Optional verification summary override'),
					exitCode: z.number().optional().describe('Optional exit code override'),
				},
				async execute(args, ctx) {
					const runtime = getSessionRuntime(ctx.sessionID).snapshot()
					const latest = runtime.verificationRecords[runtime.verificationRecords.length - 1]
					const verification = latest
						? {
								...latest,
								command: args.command ?? latest.command,
								status: args.status ?? latest.status,
								summary: args.summary ?? latest.summary,
								exitCode: args.exitCode ?? latest.exitCode,
							}
						: null
					if (!verification) return 'No verification record available for backprop.'
					const changed = applyVerificationToSpec(runtime.plan, verification)
					return [
						`Path: ${toDisplayPath(ctx.directory, resolveCaveKitSpecPath(ctx.directory))}`,
						`Verification: ${verification.command} -> ${verification.status}`,
						`Mutator mode: ${cavekitMutatorMode}`,
						`Changed: ${changed ? 'yes' : 'no'}`,
					].join('\n')
				},
			}),
			openharness_caveman_compress_file: toolFn({
				description:
					'Compress a repo-local markdown context file in place with Caveman parity rules and create a `.original` backup.',
				args: {
					filePath: z
						.string()
						.describe('Repo-local markdown file to compress, e.g. `CLAUDE.md` or `docs/guide.md`'),
					mode: z
						.enum(CAVEMAN_FILE_MODES)
						.optional()
						.describe('Compression mode: lite, full, ultra, wenyan-lite, wenyan, or wenyan-ultra'),
				},
				async execute(args, ctx) {
					const targetPath = resolveRepoLocalPath(ctx.directory, args.filePath)
					const result = compressContextFile(targetPath, args.mode ?? 'full')
					const relFile = toDisplayPath(ctx.directory, result.filePath)
					const relBackup = toDisplayPath(ctx.directory, result.backupPath)
					const saved = result.originalChars - result.compressedChars
					const validation = result.validation.valid
						? 'headings/code/inline/urls/paths/tables preserved'
						: summarizeCompressionValidation(result.validation)
					return [
						`File: ${relFile}`,
						`Backup: ${relBackup}`,
						`Mode: ${result.mode}`,
						`Chars: ${result.originalChars} -> ${result.compressedChars}`,
						`Saved: ${saved}`,
						`Changed: ${result.changed ? 'yes' : 'no'}`,
						`Validation: ${validation}`,
					].join('\n')
				},
			}),
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
					`CaveMem observations: ${countCaveMemProjectObservations(directory, getCaveMemRuntimeOptions())}`,
				]
			}),
			openharness_hook_log: createHookLogTool(() => hookLog),
			openharness_runtime_status: createRuntimeStatusTool(sessionID => {
				if (!sessionID) return null
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_telemetry_snapshot: createTelemetrySnapshotTool(sessionID => {
				if (!sessionID) return null
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_benchmark_snapshot: createBenchmarkSnapshotTool(sessionID => {
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

						if (config.enableRtk && hookInput.tool === 'bash') {
							const command = typeof output.args?.command === 'string' ? output.args.command : ''
							if (command) {
								const compression = resolveRtkCommandCompression(command, {
									binary: rtkBinary,
									fallbackMode: rtkFallbackMode,
									available: rtkAvailable,
								})
								getSessionRuntime(hookInput.sessionID).noteToolCompression(compression)
								if (
									(compression.mode === 'rewritten' || compression.mode === 'proxied') &&
									compression.finalCommand !== command
								) {
									output.args = { ...(output.args ?? {}), command: compression.finalCommand }
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
				recordCaveMemToolUse(
					hookInput.sessionID,
					cwd,
					hookInput.tool,
					hookInput.args,
					toolOutput,
					getCaveMemRuntimeOptions(hookInput.sessionID),
				)
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
				if (path) {
					sessionState.addArtifact(path)
					sessionRuntime.setCurrentTarget(path)
				}
			}
			maybeRecordVerificationState(sessionState, sessionRuntime, hookInput, toolOutput)
			const verification = classifyVerification({
				tool: hookInput.tool,
				args: hookInput.args ?? {},
				output: { output: toolOutput.output, metadata: toolOutput.metadata },
			})
			if (verification) {
				sessionRuntime.noteVerification(verification)
				if (cavekitMutatorMode === 'opencode-integrated') {
					applyVerificationToSpec(sessionRuntime.snapshot().plan, verification)
				}
			}
			maybeSetNextStep(sessionState, sessionRuntime, hookInput)
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
				const recalledMemories = await recallProjectMemories(
					getLastPrompt(lastPromptBySession, hookInput.sessionID),
					cwd,
					hookInput.sessionID,
					3,
				)
				const ctx = buildCompactionContext({
					cwd,
					lastPrompt: getLastPrompt(lastPromptBySession, hookInput.sessionID),
					plugins,
					invokedSkills: getInvokedSkills(hookInput.sessionID),
					sessionState: getSessionState(hookInput.sessionID),
					relevantMemories: recalledMemories,
					executionPlanSummary: runtimeSnapshot.plan ? summarizeExecutionPlan(runtimeSnapshot.plan) : '',
					executionPhase: runtimeSnapshot.phase,
					runtimeVerification: runtimeSnapshot.verificationSummary,
					includeCavemem: config.enableCavememBridge !== false,
					cavememDataDir: config.cavememDataDir,
					searchAlpha: cavememSettings.searchAlpha,
					embeddingProvider: cavememSettings.embeddingProvider,
					searchDefaultLimit: cavememSettings.searchDefaultLimit,
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
					const memories = await recallProjectMemories(lastPrompt, cwd, sessionID, 3)
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
			if (sessionID && compiledContext.length > 0) {
				const baselineChars = compiledContext.reduce((sum, ctx) => sum + ctx.originalChars, 0)
				const compressedChars = compiledContext.reduce((sum, ctx) => sum + ctx.artifactChars, 0)
				getSessionRuntime(sessionID).noteContextCompression(baselineChars, compressedChars)
			}

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
						const original = part.text
						part.text = compressForCaveman(part.text, cavemanState.mode)
						if (sessionID)
							getSessionRuntime(sessionID).notePromptCompression(original.length, part.text.length)
					}
					if (part.type === 'subtask') {
						const original = part.prompt
						part.prompt = compressForCaveman(part.prompt, cavemanState.mode)
						if (sessionID)
							getSessionRuntime(sessionID).notePromptCompression(original.length, part.prompt.length)
					}
				}
			}
		},

		'experimental.text.complete': async (_input, output) => {
			const cavemanState = getCavemanState(_input.sessionID)
			const baseline = output.text
			if (cavemanState.enabled) {
				output.text = compressForCaveman(output.text, cavemanState.mode)
			}
			getSessionRuntime(_input.sessionID).noteOutputCompression(baseline.length, output.text.length)
			if (config.enableCavememBridge !== false && output.text.trim()) {
				recordCaveMemAssistantStop(
					_input.sessionID,
					cwd,
					output.text,
					getCaveMemRuntimeOptions(_input.sessionID),
				)
			}
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
					recordCaveMemUserPrompt(
						hookInput.sessionID,
						cwd,
						prompt,
						getCaveMemRuntimeOptions(hookInput.sessionID),
					)
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
					? await recallProjectMemories(prompt, cwd, hookInput.sessionID, 3)
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
				setSessionNextStep(
					hookInput.sessionID,
					plan.steps[0]?.title ?? 'Apply next planned step and verify result.',
				)
			} else if (hookInput.messageID) {
				getSessionState(hookInput.sessionID)
				getSessionRuntime(hookInput.sessionID)
			}
		},

		event: async ({ event }) => {
			const type = event.type as string
			const sessionId = extractSessionId(event)
			if (config.enableCavememBridge !== false && type === 'session.created' && sessionId) {
				startCaveMemSession(sessionId, cwd, getCaveMemRuntimeOptions(sessionId))
				getSessionRuntime(sessionId).setMemorySessionPointer(`cavemem://session/${sessionId}`)
			}
			if (type === 'session.created' && sessionId) {
				const runtime = getSessionRuntime(sessionId)
				runtime.setPhase('load-context')
				runtime.setMemoryProtocol(describeMemoryProtocol())
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
				const runtimeSnapshot = getSessionRuntime(sessionId).snapshot()
				if (config.enableCavememBridge !== false) {
					const summary = buildSessionSummary(
						getSessionState(sessionId),
						getLastPrompt(lastPromptBySession, sessionId),
					)
					if (summary) {
						recordCaveMemSessionSummary(sessionId, cwd, summary, getCaveMemRuntimeOptions(sessionId))
					}
					endCaveMemSession(sessionId, getCaveMemRuntimeOptions(sessionId))
				}
				await input.client.app.log({
					body: {
						service: 'opencode-harness',
						level: 'info',
						message: buildRuntimeOpsLogSummary(sessionId, runtimeSnapshot),
					},
				})
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
	sessionRuntime: SessionRuntimeTracker,
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
		sessionRuntime.setNextStep('Summarize the verified work or continue with the next change.')
		sessionState.setNextStep('Summarize the verified work or continue with the next change.')
	}
}

function maybeSetNextStep(
	sessionState: SessionStateTracker,
	sessionRuntime: SessionRuntimeTracker,
	hookInput: { tool: string; args: any },
): void {
	if (hookInput.tool === 'read' || hookInput.tool === 'glob') {
		sessionState.setNextStep('Apply the change informed by the latest files and then verify it.')
		sessionRuntime.setNextStep('Apply the change informed by the latest files and then verify it.')
		return
	}

	if (hookInput.tool === 'openharness_skill') {
		sessionState.setNextStep('Use the loaded compatibility skill while continuing the current task.')
		sessionRuntime.setNextStep('Use the loaded compatibility skill while continuing the current task.')
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

function buildRuntimeOpsLogSummary(sessionID: string, snapshot: ReturnType<SessionRuntimeTracker['snapshot']>): string {
	const parts = [`session=${sessionID}`, `phase=${snapshot.phase}`]
	if (snapshot.plan) parts.push(`mode=${snapshot.plan.mode}`, `goal=${truncateStr(snapshot.plan.goal, 80)}`)
	if (snapshot.nextStep) parts.push(`next=${truncateStr(snapshot.nextStep, 80)}`)
	if (snapshot.currentTarget) parts.push(`target=${truncateStr(snapshot.currentTarget, 80)}`)
	if (snapshot.memoryProtocol) parts.push(`memproto=${snapshot.memoryProtocol}`)
	if (snapshot.memorySessionPointer) parts.push(`memory=${snapshot.memorySessionPointer}`)
	if (snapshot.verificationRecords.length > 0) {
		const lastVerification = snapshot.verificationRecords[snapshot.verificationRecords.length - 1]
		parts.push(`verify=${lastVerification.status}:${truncateStr(lastVerification.command, 60)}`)
	}
	parts.push(`telemetry=${formatTelemetrySummary(snapshot)}`)
	return `Runtime ops summary | ${parts.join(' | ')}`
}

function normalizeCavemanMode(raw: unknown): CavemanMode {
	if (raw === 'lite' || raw === 'full' || raw === 'ultra') return raw
	return 'full'
}

function resolveRepoLocalPath(cwd: string, filePath: string): string {
	const trimmed = filePath.trim()
	if (!trimmed) throw new Error('filePath is required')
	const resolved = resolve(cwd, trimmed)
	const rel = relative(cwd, resolved)
	if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${pathSeparator()}`))) {
		return resolved
	}
	throw new Error(`Refusing to compress file outside repo: ${filePath}`)
}

function toDisplayPath(cwd: string, filePath: string): string {
	const rel = relative(cwd, filePath)
	return rel && !rel.startsWith('..') ? rel : filePath
}

function summarizeCompressionValidation(validation: {
	missingHeadings: string[]
	missingCodeBlocks: string[]
	missingInlineCode: string[]
	missingUrls: string[]
	missingPaths: string[]
	missingTables: string[]
}): string {
	const missing: string[] = []
	if (validation.missingHeadings.length > 0) missing.push('headings')
	if (validation.missingCodeBlocks.length > 0) missing.push('code-blocks')
	if (validation.missingInlineCode.length > 0) missing.push('inline-code')
	if (validation.missingUrls.length > 0) missing.push('urls')
	if (validation.missingPaths.length > 0) missing.push('paths')
	if (validation.missingTables.length > 0) missing.push('tables')
	return missing.length > 0 ? `missing ${missing.join(', ')}` : 'ok'
}

function pathSeparator(): string {
	return process.platform === 'win32' ? '\\' : '/'
}
