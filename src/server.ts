import type { Plugin } from '@opencode-ai/plugin'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
	buildCompactionPayload,
	buildCompactionContext,
	formatCompactionAttachments,
} from './context/compaction.js'
import {
	createMemoryTools,
	createCaveMemInspectTools,
	findRelevantMemories,
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
	DeltaReadManager,
	formatArchivedOutput,
	GraphLiteService,
	PendingTodosTracker,
	ProgressiveCheckpointManager,
	WorkflowEngine,
	formatWorkflowGateMessage,
	getWorkflowPhaseLabel,
	isWorkflowMutationTool,
	renderExecutionPlan,
	resolveCaveKitSpecPath,
	SessionPrimer,
	SessionRetryManager,
	shouldDispatchVerification,
	summarizeExecutionPlan,
	SnapshotManager,
	SessionRuntimeTracker,
	ToolArchiveManager,
	toWorkflowStatusSnapshot,
	upsertCaveKitSpec,
	parseCaveKitSpec,
	runDoctorProbes,
	renderDoctorReport,
	renderDoctorSummary,
	checkBinary,
	renderGroupedGrepOutput,
	SessionRecoveryManager,
	QualityScorer,
	applyHashAnchoredPatches,
	buildAnchoredView,
	buildAnchoredViewFromFile,
	CommentChecker,
	detectAstGrepBinary,
	getCodeStatsReport,
	resolveLockedValidationCommand,
} from './runtime/index.js'
import { DelegateService, type DelegateSessionAdapter } from './runtime/delegate.js'
import { CodeIntelService } from './runtime/code-intel.js'
import type { DoctorProbeContext } from './runtime/index.js'
import { classifyVerification, combineVerificationRecords, createVerificationRecord } from './runtime/verifier.js'
import { applyVerificationToSpec } from './runtime/backprop.js'
import type { PluginConfig, CompatHook } from './shared/types.js'
import { injectCavememMcp, isCavememAvailable } from './shared/cavemem.js'
import { isRtkAvailable, resolveRtkCommandCompression } from './shared/rtk.js'
import { fileExists, readFileText, writeFileAtomic } from './shared/fs.js'

const z = toolFn.schema

// --- host-side search fast-path utilities ---

function hostGrepFastPath(
	cwd: string,
	pattern: string,
	includePattern?: string,
	maxResults: number = 200,
): string | null {
	const rgAvailable = checkBinary('rg')
	if (!rgAvailable) return null
	try {
		const args = ['--line-number', '--max-count', String(maxResults)]
		if (includePattern) {
			args.push('--glob', includePattern)
		}
		args.push(pattern, cwd)
		const result = spawnSync('rg', args, {
			cwd,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 10000,
		})
		if (result.status !== 0 && result.status !== 1) return null
		const output = (result.stdout ?? '').trim()
		if (!output) return ''
		return output
	} catch {
		return null
	}
}

function hostGlobFastPath(cwd: string, pattern: string, maxResults: number = 500): string | null {
	// Use `find` or `rg --files` for fast glob-like resolution
	// Only handle simple patterns that rg --files can serve cheaply
	const rgAvailable = checkBinary('rg')
	if (!rgAvailable) return null
	try {
		const args: string[] = ['--files']
		// Simple extension filtering from glob pattern
		const extMatch = pattern.match(/\*\.([a-zA-Z0-9]+)$/)
		if (extMatch) {
			args.push('--glob', `*.${extMatch[1]}`)
		} else if (pattern === '**/*' || pattern === '*' || pattern === '.') {
			// all files
		} else {
			// For more complex patterns, let the builtin handle it
			return null
		}
		args.push(cwd)
		const result = spawnSync('rg', args, {
			cwd,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 10000,
		})
		if (result.status !== 0 && result.status !== 1) return null
		const output = (result.stdout ?? '').trim()
		if (!output) return ''
		const lines = output.split('\n').filter(Boolean).slice(0, maxResults)
		return lines.join('\n')
	} catch {
		return null
	}
}

function resolveDelegateSessionAdapter(client: any): DelegateSessionAdapter | null {
	const sessionClient = client?.session ?? client?.v2?.session ?? null
	if (!sessionClient || typeof sessionClient.create !== 'function') return null
	const promptFn =
		typeof sessionClient.promptAsync === 'function'
			? sessionClient.promptAsync.bind(sessionClient)
			: typeof sessionClient.prompt === 'function'
				? sessionClient.prompt.bind(sessionClient)
				: null
	if (!promptFn) return null
	return {
		async createSession(input) {
			const result = await sessionClient.create({
				body: {
					title: input.label,
					...(input.parentSessionID ? { parentID: input.parentSessionID } : {}),
				},
				query: { directory: input.cwd },
			})
			const payload = unwrapDelegateClientResult(result)
			const sessionID =
				(typeof payload?.id === 'string' && payload.id) ||
				(typeof payload?.sessionID === 'string' && payload.sessionID) ||
				(typeof payload?.sessionId === 'string' && payload.sessionId) ||
				''
			if (!sessionID) throw new Error('session create returned no session id')
			return { sessionID }
		},
		async promptSession(input) {
			const result = await promptFn({
				path: { id: input.sessionID },
				body: {
					agent: input.agent,
					parts: [{ type: 'text', text: input.prompt }],
					...(input.model ? { model: input.model } : {}),
				},
				query: { directory: input.cwd },
			})
			const payload = unwrapDelegateClientResult(result)
			return {
				taskID:
					(typeof payload?.taskID === 'string' && payload.taskID) ||
					(typeof payload?.taskId === 'string' && payload.taskId) ||
					(typeof payload?.id === 'string' && payload.id) ||
					undefined,
				status: 'running',
				output: extractDelegateClientText(payload),
			}
		},
		async inspectSession(input) {
			const inspectFn =
				typeof sessionClient.get === 'function'
					? sessionClient.get.bind(sessionClient)
					: typeof sessionClient.status === 'function'
						? sessionClient.status.bind(sessionClient)
						: null
			if (!inspectFn) return null
			const result = await inspectFn({ path: { id: input.sessionID }, query: { directory: input.cwd } })
			const payload = unwrapDelegateClientResult(result)
			const status = normalizeDelegateClientStatus(payload?.status ?? payload?.state ?? payload?.type)
			return {
				status,
				output: extractDelegateClientText(payload),
				error: typeof payload?.error === 'string' ? payload.error : '',
			}
		},
		async abortSession(input) {
			if (typeof sessionClient.abort !== 'function') return
			const direct = async () => sessionClient.abort({ sessionID: input.sessionID })
			const legacy = async () =>
				sessionClient.abort({ path: { id: input.sessionID }, query: { directory: input.cwd } })
			try {
				await direct()
			} catch {
				await legacy()
			}
		},
	}
}

function unwrapDelegateClientResult(result: any): Record<string, any> {
	if (result?.error) {
		const detail = typeof result.error?.message === 'string' ? result.error.message : JSON.stringify(result.error)
		throw new Error(detail)
	}
	if (result?.data && typeof result.data === 'object') return result.data as Record<string, any>
	if (result && typeof result === 'object') return result as Record<string, any>
	return {}
}

function extractDelegateClientText(payload: Record<string, any>): string {
	if (typeof payload.output === 'string') return payload.output
	if (typeof payload.text === 'string') return payload.text
	if (typeof payload.summary === 'string') return payload.summary
	if (Array.isArray(payload.parts)) {
		return payload.parts
			.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
			.map((part: any) => part.text)
			.join('\n')
	}
	return ''
}

function normalizeDelegateClientStatus(value: unknown): 'running' | 'done' | 'failed' | 'cancelled' | undefined {
	if (typeof value !== 'string') return undefined
	const normalized = value.toLowerCase().trim()
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete' || normalized === 'idle') {
		return 'done'
	}
	if (normalized === 'failed' || normalized === 'error') return 'failed'
	if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
	if (normalized === 'running' || normalized === 'pending' || normalized === 'queued') return 'running'
	return undefined
}

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
		enableDeltaRead: options?.enableDeltaRead === true,
		deltaReadMaxCachePerSession:
			typeof options?.deltaReadMaxCachePerSession === 'number' ? options.deltaReadMaxCachePerSession : undefined,
		deltaReadMaxDiffChars:
			typeof options?.deltaReadMaxDiffChars === 'number' ? options.deltaReadMaxDiffChars : undefined,
		deltaReadExcludePatterns: options?.deltaReadExcludePatterns as string[] | undefined,
		enableToolArchive: options?.enableToolArchive === true,
		toolArchiveThresholdChars:
			typeof options?.toolArchiveThresholdChars === 'number' ? options.toolArchiveThresholdChars : undefined,
		toolArchiveExemptTools: options?.toolArchiveExemptTools as string[] | undefined,
		enableSessionRetry: options?.enableSessionRetry === true,
		sessionRetryBackoffMs:
			typeof options?.sessionRetryBackoffMs === 'number' ? options.sessionRetryBackoffMs : undefined,
		enableSessionRecovery: options?.enableSessionRecovery === true,
		enableSessionPrimer: options?.enableSessionPrimer === true,
		enableProgressiveCheckpoints: options?.enableProgressiveCheckpoints === true,
		enablePersistedCheckpoints: options?.enablePersistedCheckpoints === true,
		enableQualityScorer: options?.enableQualityScorer === true,
		enableHashAnchoredPatch: options?.enableHashAnchoredPatch === true,
		enableDelegate: options?.enableDelegate === true,
		enableCodeIntel: options?.enableCodeIntel === true,
		enableCommentChecker: options?.enableCommentChecker === true,
		commentCheckerMode: options?.commentCheckerMode === 'block' ? 'block' : 'warn',
		commentCheckerMinViolations:
			typeof options?.commentCheckerMinViolations === 'number' ? options.commentCheckerMinViolations : undefined,
		enableCodeStats: options?.enableCodeStats === true,
		enableHostGrep: options?.enableHostGrep !== false,
		enableHostGlob: options?.enableHostGlob !== false,
		enableDoctor: options?.enableDoctor !== false,
		enableSnapshots: options?.enableSnapshots === true,
		enablePendingTodoReminders: options?.enablePendingTodoReminders === true,
		enableGraphLite: options?.enableGraphLite === true,
		graphLiteMaxFiles: typeof options?.graphLiteMaxFiles === 'number' ? options.graphLiteMaxFiles : undefined,
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
		workflowMode: options?.workflowMode === 'strict' ? 'strict' : 'advisory',
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
	const sessionPrimerBySession = new Map<string, ReturnType<SessionPrimer['buildSnapshot']>>()
	const hookLog = new HookExecutionLog()
	const runtimeDataDir = join(cwd, '.openharness', 'runtime')
	const archiveManager = new ToolArchiveManager(join(runtimeDataDir, 'tool-archive'), {
		enabled: config.enableToolArchive,
		thresholdChars: config.toolArchiveThresholdChars,
		exemptTools: config.toolArchiveExemptTools,
	})
	const deltaReadManager = new DeltaReadManager({
		enabled: config.enableDeltaRead,
		maxCachePerSession: config.deltaReadMaxCachePerSession,
		maxDiffChars: config.deltaReadMaxDiffChars,
		excludePatterns: config.deltaReadExcludePatterns,
	})
	const sessionRetryManager = new SessionRetryManager(input.client as any, cwd, {
		enabled: config.enableSessionRetry,
		backoffMs: config.sessionRetryBackoffMs,
	})
	const sessionPrimer = new SessionPrimer({ enabled: config.enableSessionPrimer })
	const checkpointManager = new ProgressiveCheckpointManager(
		config.enableProgressiveCheckpoints === true,
		config.enablePersistedCheckpoints === true ? join(runtimeDataDir, 'checkpoints') : undefined,
	)
	const snapshotManager = new SnapshotManager(join(runtimeDataDir, 'snapshots'))
	const pendingTodos = new PendingTodosTracker()
	const graphLite = new GraphLiteService(
		cwd,
		join(runtimeDataDir, 'graph-lite'),
		config.enableGraphLite === true,
		config.graphLiteMaxFiles,
	)
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

	// --- New runtime managers ---
	const sessionRecoveryManager = new SessionRecoveryManager(input.client as any, cwd, {
		enabled: config.enableSessionRecovery === true,
	})
	const qualityScorer = new QualityScorer({ enabled: config.enableQualityScorer === true })
	const delegateSessionAdapter = resolveDelegateSessionAdapter(input.client as any)
	const delegateService = new DelegateService({
		enabled: config.enableDelegate === true,
		dataDir: join(runtimeDataDir, 'delegate'),
		cwd,
		sessionAdapter: delegateSessionAdapter,
	})
	const codeIntel = new CodeIntelService({
		enabled: config.enableCodeIntel === true,
		cwd,
	})
	const commentChecker = new CommentChecker({
		enabled: config.enableCommentChecker === true,
		severity: config.commentCheckerMode,
		minViolations: config.commentCheckerMinViolations,
	})
	const workflowEngine = new WorkflowEngine({
		dataDir: join(runtimeDataDir, 'workflow'),
		workflowMode: config.workflowMode,
	})
	const qualitySignalsBySession = new Map<
		string,
		{
			repeatedReads: number
			largeOutputCount: number
			archivePressure: number
			compactionCount: number
			verificationPasses: number
			verificationFails: number
			phaseCycles: number
		}
	>()
	const rgAvailable = checkBinary('rg')
	const hostSearchResultsBySession = new Map<string, string>()
	const MAX_HOST_SEARCH_CACHE = 100

	// --- End new runtime managers ---

	function getOrCreateQualitySignals(sessionID: string) {
		let signals = qualitySignalsBySession.get(sessionID)
		if (!signals) {
			signals = {
				repeatedReads: 0,
				largeOutputCount: 0,
				archivePressure: 0,
				compactionCount: 0,
				verificationPasses: 0,
				verificationFails: 0,
				phaseCycles: 0,
			}
			qualitySignalsBySession.set(sessionID, signals)
		}
		return signals
	}

	function buildDoctorProbeContext(directory: string): DoctorProbeContext {
		return {
			cwd: directory,
			runtimeDataDir,
			config: {
				enableMemory: config.enableMemory !== false,
				enableHooks: config.enableHooks !== false,
				enableCompaction: config.enableCompaction !== false,
				enableSessionRetry: config.enableSessionRetry === true,
				enableSessionRecovery: config.enableSessionRecovery === true,
				enableSessionPrimer: config.enableSessionPrimer === true,
				enableProgressiveCheckpoints: config.enableProgressiveCheckpoints === true,
				enableGraphLite: config.enableGraphLite === true,
				enableHashAnchoredPatch: config.enableHashAnchoredPatch === true,
				enableDelegate: config.enableDelegate === true,
				enableCodeIntel: config.enableCodeIntel === true,
				enableCommentChecker: config.enableCommentChecker === true,
				enableCodeStats: config.enableCodeStats === true,
				enableRtk: config.enableRtk === true,
				enableCavememBridge: config.enableCavememBridge !== false,
				enableCavememMcp: config.enableCavememMcp !== false,
				enablePendingTodoReminders: config.enablePendingTodoReminders === true,
				enableSnapshots: config.enableSnapshots === true,
				enableToolArchive: config.enableToolArchive === true,
				enableDeltaRead: config.enableDeltaRead === true,
			},
			binaries: {
				rtkAvailable,
				cavememAvailable,
				rgAvailable,
				astGrepAvailable: detectAstGrepBinary(directory) !== null,
				gitAvailable: checkBinary('git'),
				bunAvailable: checkBinary('bun'),
			},
			plugins: {
				discovered: report.discovered,
				enabled: report.enabled,
				blocked: report.blocked,
				malformed: report.malformed,
			},
			graphLiteStatus: graphLite.getStatus(),
			specPresent: fileExists(join(directory, 'SPEC.md')),
		}
	}

	function refreshDoctorSummary(sessionID: string, directory: string = cwd): string {
		if (config.enableDoctor === false) return ''
		const summary = renderDoctorSummary(runDoctorProbes(buildDoctorProbeContext(directory))).replace(
			/^doctor:\s*/,
			'',
		)
		getSessionRuntime(sessionID).setDoctorSummary(summary)
		return summary
	}

	function scoreSessionQuality(sessionID: string) {
		if (config.enableQualityScorer !== true) return null
		const signals = getOrCreateQualitySignals(sessionID)
		const result = qualityScorer.score({
			repeatedReads: signals.repeatedReads,
			largeOutputCount: signals.largeOutputCount,
			archivePressure: signals.archivePressure,
			compactionCount: signals.compactionCount,
			verificationPassRate: signals.verificationPasses,
			verificationTotal: signals.verificationPasses + signals.verificationFails,
			todoPressure: pendingTodos.pending(sessionID).length,
			phaseCycles: signals.phaseCycles,
		})
		getSessionRuntime(sessionID).setQualitySummary(qualityScorer.renderCompactSummary(result))
		checkpointManager.updateQuality(sessionID, result.score, result.grade)
		return result
	}

	function refreshRecoverySummary(sessionID: string): string {
		const audit = sessionRecoveryManager.getAudit(sessionID)
		const summary = audit ? `retries=${audit.totalRetries} class=${audit.lastClassification ?? 'n/a'}` : ''
		getSessionRuntime(sessionID).setRecoverySummary(summary)
		return summary
	}

	function refreshDelegateSummary(sessionID: string): string {
		const summary = delegateService.renderSummary()
		if (sessionID) getSessionRuntime(sessionID).setDelegateSummary(summary)
		return summary
	}

	function syncWorkflowRuntime(sessionID: string): void {
		if (!sessionID) return
		const workflow = workflowEngine.getSnapshot(sessionID)
		const runtime = getSessionRuntime(sessionID)
		runtime.setWorkflowSnapshot(workflow)
		if (!workflow) return
		if (workflow.currentTarget) runtime.setCurrentTarget(workflow.currentTarget)
		if (workflow.nextRequiredAction) runtime.setNextStep(workflow.nextRequiredAction)
	}

	function renderDelegateJob(job: {
		id: string
		label: string
		kind: string
		mode: string
		status: string
		cwd: string
		command: string
		startedAt: number | null
		completedAt: number | null
		exitCode: number | null
		output: string
		error: string
		sessionID?: string
		taskID?: string
		agent?: string
		model?: string
	}) {
		const lines = [
			`Job: ${job.id}`,
			`Label: ${job.label}`,
			`Kind: ${job.kind}`,
			`Mode: ${job.mode}`,
			`Status: ${job.status}`,
			`CWD: ${toDisplayPath(cwd, job.cwd || cwd)}`,
		]
		if (job.mode === 'shell') {
			lines.push(`Command: ${job.command}`)
		} else {
			if (job.agent) lines.push(`Agent: ${job.agent}`)
			if (job.model) lines.push(`Model: ${job.model}`)
			if (job.sessionID) lines.push(`Session: ${job.sessionID}`)
			if (job.taskID) lines.push(`Task: ${job.taskID}`)
		}
		if (job.startedAt) lines.push(`Started: ${new Date(job.startedAt).toISOString()}`)
		if (job.completedAt) lines.push(`Completed: ${new Date(job.completedAt).toISOString()}`)
		if (job.exitCode !== null) lines.push(`Exit code: ${job.exitCode}`)
		if (job.output) lines.push(`Output: ${job.output.slice(0, 2000)}`)
		if (job.error) lines.push(`Error: ${job.error.slice(0, 1000)}`)
		return lines.join('\n')
	}

	function buildGraphToolHints(input: {
		directory: string
		prompt: string
		specContent?: string
		fallbackFiles?: string[]
	}): {
		statusLine: string
		ready: boolean
		primaryFile: string
		likelyFiles: string[]
		symbolMatches: string[]
		cochangeFiles: string[]
		blastRadiusFiles: string[]
		verificationHints: string[]
	} {
		const status = graphLite.getStatus()
		const stats = status.stats
		const statusLine = `${status.state} (${stats?.files ?? 0} files, ${stats?.symbols ?? 0} symbols${typeof stats?.symbolRefs === 'number' ? `, ${stats.symbolRefs} refs` : ''})`
		if (!status.ready) {
			return {
				statusLine,
				ready: false,
				primaryFile: '',
				likelyFiles: [],
				symbolMatches: [],
				cochangeFiles: [],
				blastRadiusFiles: [],
				verificationHints: [],
			}
		}

		const parsedSpec = input.specContent ? parseCaveKitSpec(input.specContent) : null
		const specFiles = uniqueStrings(
			(parsedSpec?.interfaces ?? [])
				.flatMap(line => extractReferencedPaths(line))
				.filter(path => {
					try {
						return fileExists(resolveRepoLocalPath(input.directory, path))
					} catch {
						return false
					}
				}),
		)
		const compiled = compileUserPrompt(input.prompt)
		const symbolMatches = uniqueStrings(
			compiled.keywords
				.slice(0, 3)
				.flatMap(keyword =>
					graphLite.searchSymbols(keyword, 3).map(result => `${result.symbol.name}@${result.filePath}`),
				),
		)
		const symbolFiles = symbolMatches.map((match: string) => match.split('@').slice(-1)[0] ?? '').filter(Boolean)
		const candidateFiles = uniqueStrings([
			...(input.fallbackFiles ?? []),
			...specFiles,
			...symbolFiles,
			...graphLite.getTopFiles(3).map(file => file.path),
		]).filter(Boolean)
		const primaryFile = candidateFiles[0] ?? ''
		const cochangeFiles = primaryFile ? graphLite.getCoChangeHints(primaryFile, 3).map(hint => hint.path) : []
		const blastRadiusFiles = primaryFile ? graphLite.getBlastRadiusDetail(primaryFile).files.slice(0, 3) : []
		const likelyFiles = uniqueStrings([
			primaryFile,
			...specFiles,
			...symbolFiles,
			...cochangeFiles,
			...blastRadiusFiles,
		]).filter(Boolean)
		const verificationHints = uniqueStrings([...blastRadiusFiles, ...cochangeFiles, ...likelyFiles.slice(1)]).slice(
			0,
			5,
		)
		return {
			statusLine,
			ready: true,
			primaryFile,
			likelyFiles: likelyFiles.slice(0, 5),
			symbolMatches: symbolMatches.slice(0, 5),
			cochangeFiles,
			blastRadiusFiles,
			verificationHints,
		}
	}

	function renderGraphToolHintLines(hints: {
		statusLine: string
		ready: boolean
		likelyFiles: string[]
		symbolMatches: string[]
		cochangeFiles: string[]
		blastRadiusFiles: string[]
		verificationHints: string[]
	}): string[] {
		const lines = [`Graph: ${hints.statusLine}`]
		if (hints.likelyFiles.length > 0) lines.push(`Repo hints: ${hints.likelyFiles.join(', ')}`)
		if (hints.symbolMatches.length > 0) lines.push(`Symbol hits: ${hints.symbolMatches.join(', ')}`)
		if (hints.cochangeFiles.length > 0) lines.push(`Co-change risk: ${hints.cochangeFiles.join(', ')}`)
		if (hints.blastRadiusFiles.length > 0) lines.push(`Blast radius: ${hints.blastRadiusFiles.join(', ')}`)
		if (hints.verificationHints.length > 0) lines.push(`Verification focus: ${hints.verificationHints.join(', ')}`)
		return lines
	}

	function uniqueStrings(values: string[]): string[] {
		return Array.from(new Set(values))
	}

	function extractReferencedPaths(input: string): string[] {
		return uniqueStrings(
			Array.from(
				input.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?/g),
				match => match[0] ?? '',
			),
		)
	}

	function applyCommentGuardrail(sessionID: string, tool: string, args: Record<string, unknown>): void {
		if (config.enableCommentChecker !== true) return
		const payloads = collectCommentPayloads(tool, args)
		if (payloads.length === 0) {
			getSessionRuntime(sessionID).setCommentSummary('')
			return
		}
		const warnings: string[] = []
		for (const payload of payloads) {
			const result = commentChecker.check(payload)
			if (result.warning) warnings.push(result.warning)
		}
		if (warnings.length === 0) {
			getSessionRuntime(sessionID).setCommentSummary('')
			return
		}
		const summary = `${warnings.length} warning(s); mode=${commentChecker.getSeverity()}`
		getSessionRuntime(sessionID).setCommentSummary(summary)
		if (commentChecker.getSeverity() === 'block') {
			throw new Error(`Comment checker blocked mutation. ${warnings[0]}`)
		}
	}

	function collectCommentPayloads(tool: string, args: Record<string, unknown>): string[] {
		const payloads: string[] = []
		if (tool === 'write' && typeof args.content === 'string') payloads.push(args.content)
		if (tool === 'edit' && typeof args.newString === 'string') payloads.push(args.newString)
		if (tool === 'openharness_patch' && Array.isArray(args.patches)) {
			for (const patch of args.patches) {
				if (!patch || typeof patch !== 'object') continue
				const next = (patch as { newContent?: unknown }).newContent
				if (typeof next === 'string') payloads.push(next)
			}
		}
		if (tool === 'openharness_cavekit_build' && Array.isArray(args.writeFiles)) {
			for (const entry of args.writeFiles) {
				if (!entry || typeof entry !== 'object') continue
				const next = (entry as { content?: unknown }).content
				if (typeof next === 'string') payloads.push(next)
			}
		}
		return payloads.filter(payload => payload.includes('//') || payload.includes('#') || payload.includes('/*'))
	}

	function collectArtifactPaths(tool: string, args: Record<string, unknown>): string[] {
		const artifacts = new Set<string>()
		const pushPath = (filePath: unknown) => {
			if (typeof filePath !== 'string' || !filePath.trim()) return
			try {
				artifacts.add(toDisplayPath(cwd, resolveRepoLocalPath(cwd, filePath)))
			} catch {
				artifacts.add(filePath.trim())
			}
		}

		if (tool === 'read' || tool === 'write' || tool === 'edit' || tool === 'openharness_caveman_compress_file') {
			pushPath(args.filePath)
		}
		if (tool === 'glob' && typeof args.pattern === 'string' && args.pattern.trim()) {
			artifacts.add(args.pattern.trim())
		}
		if (tool === 'openharness_patch') {
			pushPath(args.file)
		}
		if (tool === 'openharness_graph_query' || tool === 'openharness_graph_symbols') {
			pushPath(args.file)
		}
		if (tool === 'openharness_intel_outline') {
			pushPath(args.file)
		}
		if (tool === 'openharness_intel_ast_search') {
			pushPath(args.path)
		}
		if (tool === 'openharness_cavekit_spec' || tool === 'openharness_cavekit_backprop') {
			artifacts.add(toDisplayPath(cwd, resolveCaveKitSpecPath(cwd)))
		}
		if (tool === 'openharness_cavekit_build') {
			artifacts.add(toDisplayPath(cwd, resolveCaveKitSpecPath(cwd)))
			if (Array.isArray(args.writeFiles)) {
				for (const entry of args.writeFiles) {
					if (!entry || typeof entry !== 'object') continue
					pushPath((entry as { path?: unknown }).path)
				}
			}
			if (Array.isArray(args.deleteFiles)) {
				for (const entry of args.deleteFiles) pushPath(entry)
			}
		}

		return Array.from(artifacts)
	}

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

	async function appendPromptToSession(sessionID: string, text: string): Promise<void> {
		if (!text.trim()) return
		const tui = (input.client as any).tui
		if (!tui?.appendPrompt) return
		await Promise.resolve(
			tui.appendPrompt({
				body: { text },
				query: { directory: cwd },
			}),
		)
	}

	function maybeCaptureHarnessSnapshots(toolName: string, sessionID: string, args: Record<string, unknown>): void {
		if (config.enableSnapshots !== true) return
		const capturePaths: string[] = []
		if (toolName === 'openharness_cavekit_spec' || toolName === 'openharness_cavekit_backprop') {
			capturePaths.push(resolveCaveKitSpecPath(cwd))
		}
		if (toolName === 'openharness_cavekit_build') {
			capturePaths.push(resolveCaveKitSpecPath(cwd))
			const writeFiles = Array.isArray(args.writeFiles) ? args.writeFiles : []
			for (const entry of writeFiles) {
				if (!entry || typeof entry !== 'object') continue
				const path =
					typeof (entry as { path?: unknown }).path === 'string' ? (entry as { path: string }).path : ''
				if (path) capturePaths.push(resolveRepoLocalPath(cwd, path))
			}
			const deleteFiles = Array.isArray(args.deleteFiles) ? args.deleteFiles : []
			for (const entry of deleteFiles) {
				if (typeof entry !== 'string') continue
				capturePaths.push(resolveRepoLocalPath(cwd, entry))
			}
		}
		if (toolName === 'openharness_caveman_compress_file' && typeof args.filePath === 'string') {
			capturePaths.push(resolveRepoLocalPath(cwd, args.filePath))
		}
		if (toolName === 'openharness_patch' && typeof args.file === 'string') {
			capturePaths.push(resolveRepoLocalPath(cwd, args.file))
		}
		for (const absPath of capturePaths) snapshotManager.capture(cwd, sessionID, absPath)
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
		checkpointManager.recordMessage(sessionID, prompt.length)
		checkpointManager.recordDecision(sessionID, `prompt: ${truncateStr(prompt.trim(), 120)}`)
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
		sessionPrimerBySession.delete(sessionID)
		deltaReadManager.reset(sessionID)
		sessionRetryManager.reset(sessionID)
		sessionRecoveryManager.reset(sessionID)
		checkpointManager.reset(sessionID)
		pendingTodos.reset(sessionID)
		qualityScorer.reset(sessionID)
		qualitySignalsBySession.delete(sessionID)
		sessionPrimer.reset(sessionID)
		// Clean up any stale host search results for this session
		for (const key of hostSearchResultsBySession.keys()) {
			if (key.startsWith(`${sessionID}:`)) hostSearchResultsBySession.delete(key)
		}
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
			openharness_expand: toolFn({
				description: 'Retrieve a full tool result previously archived behind a compact preview.',
				args: {
					id: z.string().describe('Archive id returned by the compact preview'),
				},
				async execute(args) {
					const entry = archiveManager.retrieve(args.id)
					if (!entry) return `Archive entry '${args.id}' not found.`
					return entry.output
				},
			}),
			expand: toolFn({
				description: 'Compatibility alias for openharness_expand.',
				args: {
					id: z.string().describe('Archive id returned by the compact preview'),
				},
				async execute(args) {
					const entry = archiveManager.retrieve(args.id)
					if (!entry) return `Archive entry '${args.id}' not found.`
					return entry.output
				},
			}),
			openharness_graph_status: toolFn({
				description: 'Show graph-lite readiness or trigger an on-demand index scan.',
				args: {
					action: z.enum(['status', 'scan']).optional().describe('status (default) or scan'),
				},
				async execute(args) {
					const status = args.action === 'scan' ? await graphLite.scan() : graphLite.getStatus()
					return [
						`State: ${status.state}`,
						`Ready: ${status.ready ? 'yes' : 'no'}`,
						`Files: ${status.stats?.files ?? 0}`,
						`Symbols: ${status.stats?.symbols ?? 0}`,
						`Edges: ${status.stats?.edges ?? 0}`,
						`Updated: ${status.updatedAt ? new Date(status.updatedAt).toISOString() : 'n/a'}`,
						`Message: ${status.message ?? 'n/a'}`,
					].join('\n')
				},
			}),
			openharness_graph_query: toolFn({
				description:
					'Query graph-lite file importance, symbols, dependencies, dependents, blast radius, callers, callees, cochange hints, package groups, and symbol search.',
				args: {
					action: z.enum([
						'top_files',
						'file_symbols',
						'file_deps',
						'file_dependents',
						'blast_radius',
						'blast_radius_detail',
						'search_symbols',
						'callers',
						'callees',
						'cochange',
						'package_groups',
					]),
					file: z.string().optional().describe('Repo-local file path for file-scoped graph queries'),
					query: z.string().optional().describe('Search query for symbol search'),
					limit: z.number().optional().describe('Optional result limit'),
				},
				async execute(args) {
					const status = graphLite.getStatus()
					if (!status.ready) return 'Graph-lite not ready. Run openharness_graph_status action="scan" first.'
					if (args.action === 'top_files') {
						const rows = graphLite.getTopFiles(args.limit ?? 10)
						if (rows.length === 0) return 'No indexed files.'
						return rows
							.map(
								row =>
									`- ${row.path} (score ${row.score.toFixed(2)}, ${row.lines} lines, ${row.symbols} symbols)`,
							)
							.join('\n')
					}
					if (args.action === 'search_symbols') {
						const query = args.query ?? ''
						if (!query) return 'query parameter required for search_symbols'
						const results = graphLite.searchSymbols(query, args.limit ?? 20)
						if (results.length === 0) return `No symbols matching '${query}'`
						return results
							.map(
								r =>
									`- ${r.symbol.name} (${r.symbol.kind}) [${r.filePath}:${r.symbol.line}]${r.symbol.isExported ? ' [exported]' : ''}`,
							)
							.join('\n')
					}
					if (args.action === 'package_groups') {
						const groups = graphLite.getPackageGroups()
						if (groups.length === 0) return 'No indexed files.'
						return groups
							.slice(0, args.limit ?? 20)
							.map(
								g =>
									`- ${g.directory}/ (${g.files.length} files, ${g.symbolCount} symbols, ${g.edgeCount} edges)`,
							)
							.join('\n')
					}
					if (!args.file) return 'file parameter required'
					if (args.action === 'file_symbols') {
						const symbols = graphLite.getFileSymbols(args.file)
						if (symbols.length === 0) return `No symbols found in ${args.file}`
						return symbols
							.slice(0, args.limit ?? 20)
							.map(
								symbol =>
									`- ${symbol.name} (${symbol.kind})${symbol.isExported ? ' [exported]' : ''} [line ${symbol.line}]`,
							)
							.join('\n')
					}
					if (args.action === 'file_deps') {
						const deps = graphLite.getFileDependencies(args.file)
						return deps.length > 0
							? deps
									.slice(0, args.limit ?? 20)
									.map(dep => `- ${dep}`)
									.join('\n')
							: `No dependencies found for ${args.file}`
					}
					if (args.action === 'file_dependents') {
						const dependents = graphLite.getFileDependents(args.file)
						return dependents.length > 0
							? dependents
									.slice(0, args.limit ?? 20)
									.map(dep => `- ${dep}`)
									.join('\n')
							: `No dependents found for ${args.file}`
					}
					if (args.action === 'blast_radius') {
						return `Blast radius for ${args.file}: ${graphLite.getBlastRadius(args.file)} file(s)`
					}
					if (args.action === 'blast_radius_detail') {
						const detail = graphLite.getBlastRadiusDetail(args.file)
						if (detail.count === 0) return `No blast radius for ${args.file}`
						const lines = [`Blast radius for ${args.file}: ${detail.count} file(s)`, '']
						for (const entry of detail.scores.slice(0, args.limit ?? 20)) {
							lines.push(`- ${entry.path} (depth ${entry.depth})`)
						}
						return lines.join('\n')
					}
					if (args.action === 'callers') {
						const symName = args.query ?? ''
						if (!symName) return 'query parameter (symbol name) required for callers'
						const callers = graphLite.getCallers(args.file, symName)
						if (callers.length === 0) return `No callers of ${symName} from ${args.file}`
						return callers
							.slice(0, args.limit ?? 20)
							.map(c => `- ${c.filePath} (imports ${c.symbolName})`)
							.join('\n')
					}
					if (args.action === 'callees') {
						const callees = graphLite.getCallees(args.file)
						if (callees.length === 0) return `No named imports found for ${args.file}`
						return callees
							.slice(0, args.limit ?? 20)
							.map(c => `- ${c.symbolName} from ${c.sourcePath}`)
							.join('\n')
					}
					if (args.action === 'cochange') {
						const hints = graphLite.getCoChangeHints(args.file, args.limit ?? 10)
						if (hints.length === 0) return `No co-change hints for ${args.file}`
						return hints
							.map(
								h =>
									`- ${h.path} (shared deps=${h.sharedDependencies}, shared dependents=${h.sharedDependents}, score=${h.score})`,
							)
							.join('\n')
					}
					return 'Unknown action'
				},
			}),
			openharness_graph_symbols: toolFn({
				description:
					'Query symbol-level plus import-graph parity information: find/search, signature lookup, callers, file import lists, references, blast radius, and approximate import cycles.',
				args: {
					action: z.enum([
						'find',
						'search',
						'signature',
						'callers',
						'imports',
						'import_cycles',
						'callees',
						'references',
						'blast_radius',
						'call_cycles',
					]),
					name: z.string().optional().describe('Symbol name or search query'),
					file: z
						.string()
						.optional()
						.describe('Optional repo-local file path to scope or disambiguate results'),
					kind: z.string().optional().describe('Optional symbol kind filter'),
					limit: z.number().optional().describe('Optional result limit'),
				},
				async execute(args) {
					const status = graphLite.getStatus()
					if (!status.ready) return 'Graph-lite not ready. Run openharness_graph_status action="scan" first.'
					const limit = args.limit ?? 20
					const scopeMatches = (query: string) =>
						graphLite
							.searchSymbols(query, Math.max(limit, 10))
							.filter(match => !args.kind || match.symbol.kind === args.kind)
							.filter(
								match =>
									!args.file ||
									match.filePath === args.file ||
									match.filePath.endsWith(args.file.replace(/^\.\//, '')),
							)
					if (args.action === 'call_cycles' || args.action === 'import_cycles') {
						const cycles = graphLite.getImportCycleHints(limit)
						if (cycles.length === 0) return 'No approximate import cycles found.'
						const lines =
							args.action === 'call_cycles'
								? [
										'Approx import-cycle parity for compatibility `call_cycles` (not semantic call graph cycles).',
										'',
									]
								: ['Approx import cycles from graph-lite import edges.', '']
						return lines
							.concat(
								cycles.map(
									(cycle, index) =>
										`- Cycle ${index + 1}: ${cycle.cycle.map(entry => `${entry.name}@${entry.path}:${entry.line}`).join(' -> ')}`,
								),
							)
							.join('\n')
					}
					if ((args.action === 'imports' || args.action === 'callees') && !args.file && !args.name) {
						return 'file parameter required for imports (or provide name to infer containing file)'
					}
					if (!args.name && args.action !== 'imports' && args.action !== 'callees')
						return 'name parameter required'
					if (args.action === 'find' || args.action === 'search') {
						const matches = scopeMatches(args.name!).slice(0, limit)
						if (matches.length === 0) return `No symbols found matching '${args.name}'`
						return matches
							.map(
								match =>
									`- ${match.symbol.name} (${match.symbol.kind}) [${match.filePath}:${match.symbol.line}]${match.symbol.isExported ? ' [exported]' : ''}`,
							)
							.join('\n')
					}
					if (args.action === 'references') {
						const refs = graphLite.getSymbolReferences(args.name!, limit)
						if (refs.length === 0) return `No references found for '${args.name}'.`
						return refs
							.map(
								ref =>
									`- ${ref.filePath}:${ref.line} ${ref.context || `[${ref.kind}] ${ref.symbolName}`}`,
							)
							.join('\n')
					}
					if (args.action === 'blast_radius') {
						const blast = graphLite.getSymbolBlastRadius(args.name!, 5)
						if (blast.totalAffected === 0) return `No transitive callers found for '${args.name}'.`
						return [
							`Root: ${blast.root.name} @ ${blast.root.path}:${blast.root.line}`,
							`Affected: ${blast.totalAffected}`,
							...blast.affected
								.slice(0, limit)
								.map(entry => `- ${entry.name} @ ${entry.path}:${entry.line} (depth ${entry.depth})`),
						].join('\n')
					}
					const matches = args.name ? scopeMatches(args.name) : []
					const selected = matches[0]
					if (!selected && args.action !== 'imports' && args.action !== 'callees') {
						return `No symbols found matching '${args.name}'`
					}
					if (args.action === 'signature') {
						const signature = graphLite.getSymbolSignature(selected.filePath, selected.symbol.name)
						if (!signature) return `No signature found for '${args.name}'.`
						return [
							`File: ${signature.filePath}:${signature.line}`,
							'```ts',
							signature.signature,
							'```',
						].join('\n')
					}
					if (args.action === 'callers') {
						const callers = graphLite.getCallers(selected.filePath, selected.symbol.name)
						if (callers.length === 0) return `No callers found for '${selected.symbol.name}'.`
						return callers
							.slice(0, limit)
							.map(caller => `- ${caller.filePath} imports ${caller.symbolName}`)
							.join('\n')
					}
					const importFile = args.file ?? selected?.filePath
					if (!importFile) return 'file parameter required for imports'
					const imports = graphLite.getImportedSymbols(importFile)
					if (imports.length === 0) return `No import-graph matches found for '${importFile}'.`
					const header =
						args.action === 'callees'
							? `Approx import parity for compatibility \`callees\` from ${importFile} (not per-symbol semantic callees).`
							: `Approx file imports for ${importFile}.`
					return [
						header,
						'',
						...imports.slice(0, limit).map(entry => `- ${entry.symbolName} from ${entry.sourcePath}`),
					].join('\n')
				},
			}),
			openharness_graph_analyze: toolFn({
				description:
					'Run lightweight graph-lite analysis for unused exports, duplication, near-duplicates, and circular dependencies.',
				args: {
					action: z.enum(['unused_exports', 'duplication', 'near_duplicates', 'circular_deps']),
					limit: z.number().optional().describe('Optional result limit'),
					threshold: z
						.number()
						.optional()
						.describe('Optional near-duplicate similarity threshold (default 0.85)'),
				},
				async execute(args) {
					const status = graphLite.getStatus()
					if (!status.ready) return 'Graph-lite not ready. Run openharness_graph_status action="scan" first.'
					const limit = args.limit ?? 20
					if (args.action === 'unused_exports') {
						const unused = graphLite.getUnusedExports(limit)
						if (unused.length === 0) return 'No approximate unused exports found.'
						return unused
							.map(entry => `- ${entry.symbolName} (${entry.kind}) at ${entry.filePath}:${entry.line}`)
							.join('\n')
					}
					if (args.action === 'duplication') {
						const blocks = graphLite.getDuplicateBlocks(limit)
						if (blocks.length === 0) return 'No duplicate code blocks found.'
						return blocks
							.map(block => {
								const hits = block.occurrences
									.map(hit => `${hit.filePath}:${hit.startLine}-${hit.endLine}`)
									.join(', ')
								return `- ${hits} :: ${block.snippet.replace(/\s+/g, ' ').slice(0, 160)}`
							})
							.join('\n')
					}
					if (args.action === 'near_duplicates') {
						const pairs = graphLite.getNearDuplicateFiles(limit, args.threshold ?? 0.85)
						if (pairs.length === 0) return 'No near-duplicate files found.'
						return pairs
							.map(
								pair =>
									`- ${pair.leftPath} <-> ${pair.rightPath} (${(pair.similarity * 100).toFixed(1)}%)`,
							)
							.join('\n')
					}
					const cycles = graphLite.getCircularDependencyCycles(limit)
					if (cycles.length === 0) return 'No circular dependencies found.'
					return cycles.map(cycle => `- ${cycle.join(' -> ')} -> ${cycle[0]}`).join('\n')
				},
			}),
			openharness_fs_undo: toolFn({
				description: 'Restore the latest snapshot captured for a harness-owned file mutation.',
				args: {
					filePath: z.string().describe('Repo-local file path to restore from the latest snapshot'),
				},
				async execute(args, ctx) {
					const restored = snapshotManager.restoreLatest(ctx.directory, args.filePath)
					if (!restored) return `No snapshot found for ${args.filePath}`
					return [
						`File: ${args.filePath}`,
						`Restored from: ${new Date(restored.timestamp).toISOString()}`,
						`State: ${restored.exists ? 'restored prior content' : 'deleted file restored to missing state'}`,
					].join('\n')
				},
			}),
			openharness_patch: toolFn({
				description:
					'View hash anchors for a file or apply small hash-anchored patches atomically. Use this for drift-safe targeted edits.',
				args: {
					action: z.enum(['view', 'apply']).describe('view anchors or apply patch operations'),
					file: z.string().describe('Repo-local file path'),
					startLine: z.number().optional().describe('Optional start line for anchored view'),
					endLine: z.number().optional().describe('Optional end line for anchored view'),
					patches: z
						.array(
							z.object({
								anchor: z.string().optional(),
								anchorStart: z.string().optional(),
								anchorEnd: z.string().optional(),
								newContent: z.string(),
							}),
						)
						.optional()
						.describe('Ordered anchored patch operations for apply mode'),
				},
				async execute(args, ctx) {
					if (config.enableHashAnchoredPatch !== true) return 'Hash-anchored patch disabled by config.'
					try {
						const targetPath = resolveRepoLocalPath(ctx.directory, args.file)
						if (args.action === 'view') {
							const content = args.startLine || args.endLine ? (readFileText(targetPath) ?? '') : ''
							const view =
								args.startLine || args.endLine
									? buildAnchoredView(content, args.startLine ?? 1, args.endLine)
									: buildAnchoredViewFromFile(targetPath)
							return [`File: ${toDisplayPath(ctx.directory, targetPath)}`, '', view || 'No lines.'].join(
								'\n',
							)
						}
						if (!args.patches || args.patches.length === 0)
							return 'patches parameter required for apply mode'
						const result = applyHashAnchoredPatches(targetPath, args.patches)
						if (!result.ok) return `ERROR: ${result.error}`
						return [`OK — ${toDisplayPath(ctx.directory, result.path)}`, ...result.report].join('\n')
					} catch (error) {
						return `ERROR: ${error instanceof Error ? error.message : String(error)}`
					}
				},
			}),
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
					const graphHints = buildGraphToolHints({
						directory: ctx.directory,
						prompt: [args.focus, result.goal, ...result.selectedTasks.map(task => task.task)]
							.filter(Boolean)
							.join('. '),
						specContent: result.content,
					})
					if (firstTask) {
						runtime.setCurrentTarget(graphHints.primaryFile || firstTask.task)
						runtime.setNextStep(
							`Implement ${firstTask.id}${graphHints.primaryFile ? ` around ${graphHints.primaryFile}` : ''} and verify with ${result.validationCommands.join(' + ') || 'project checks'}.`,
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
						...renderGraphToolHintLines(graphHints),
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
					const graphHints = buildGraphToolHints({
						directory: ctx.directory,
						prompt: args.focus?.trim() || result.goal,
						specContent: result.content,
					})
					const lines = [
						'## CaveKit Check',
						'',
						`Path: ${toDisplayPath(ctx.directory, result.path)}`,
						`Goal: ${result.goal}`,
						`Task coverage: ${result.taskCoverage}`,
						`Verify: ${result.validationCommands.join(' ; ') || 'n/a'}`,
						...renderGraphToolHintLines(graphHints),
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
					const workflow = workflowEngine.getSnapshot(ctx.sessionID)
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
					const changed = applyVerificationToSpec(
						runtime.plan ?? workflow?.executionPlan ?? null,
						verification,
					)
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
				refreshDelegateSummary(sessionID)
				syncWorkflowRuntime(sessionID)
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_telemetry_snapshot: createTelemetrySnapshotTool(sessionID => {
				if (!sessionID) return null
				refreshDelegateSummary(sessionID)
				syncWorkflowRuntime(sessionID)
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_benchmark_snapshot: createBenchmarkSnapshotTool(sessionID => {
				if (!sessionID) return null
				refreshDelegateSummary(sessionID)
				syncWorkflowRuntime(sessionID)
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_caveman_stack_status: createRuntimeStatusTool(sessionID => {
				if (!sessionID) return null
				refreshDelegateSummary(sessionID)
				syncWorkflowRuntime(sessionID)
				return getSessionRuntime(sessionID).snapshot()
			}),
			openharness_doctor: toolFn({
				description:
					'Run OpenHarness doctor probes to check runtime health: binaries, plugins, config, and feature readiness.',
				args: {
					verbose: z.boolean().optional().describe('Include all checks including OK results'),
				},
				async execute(args, ctx) {
					const doctorReport = runDoctorProbes(buildDoctorProbeContext(ctx.directory))
					if (ctx.sessionID)
						getSessionRuntime(ctx.sessionID).setDoctorSummary(renderDoctorSummary(doctorReport))
					return renderDoctorReport(doctorReport, args.verbose === true)
				},
			}),
			openharness_recovery_audit: toolFn({
				description: 'Show session recovery audit trail: retry attempts, classifications, and backoff history.',
				args: {},
				async execute(_args, ctx) {
					return sessionRecoveryManager.renderAudit(ctx.sessionID)
				},
			}),
			openharness_quality: toolFn({
				description: 'Show session quality score and signal breakdown for the current session.',
				args: {},
				async execute(_args, ctx) {
					const result = scoreSessionQuality(ctx.sessionID)
					if (!result) return 'No quality signals recorded for this session.'
					return qualityScorer.renderQuality(result)
				},
			}),
			openharness_delegate_start: toolFn({
				description:
					'Start a bounded background delegate job. Supports repo-scoped shell execution and optional child-session delegation when host session APIs are available.',
				args: {
					label: z.string().describe('Human-readable label for the job'),
					kind: z.enum(['index', 'review', 'research', 'custom']).describe('Job category'),
					mode: z
						.enum(['shell', 'session'])
						.optional()
						.describe('Delegate transport. Defaults to shell unless agent/prompt is provided.'),
					command: z.string().optional().describe('Shell command to execute for shell mode'),
					agent: z.string().optional().describe('Agent to use for session mode'),
					prompt: z.string().optional().describe('Instruction or question for session mode'),
					context: z.string().optional().describe('Optional extra context prepended to the session prompt'),
					model: z.string().optional().describe('Optional model override for session mode'),
				},
				async execute(args, ctx) {
					const mode = args.mode ?? (args.agent && args.prompt ? 'session' : 'shell')
					if (mode === 'session' && (!args.agent || !args.prompt)) {
						return 'Session delegate requires both agent and prompt.'
					}
					if (mode === 'shell' && !args.command) {
						return 'Shell delegate requires command.'
					}
					const job =
						mode === 'session'
							? await delegateService.startSession({
									label: args.label,
									kind: args.kind,
									agent: args.agent ?? '',
									prompt: args.prompt ?? '',
									context: args.context,
									model: args.model,
									cwd: ctx.directory,
									parentSessionID: ctx.sessionID,
								})
							: delegateService.start(args.label, args.kind, args.command ?? '', ctx.directory)
					refreshDelegateSummary(ctx.sessionID)
					return renderDelegateJob(job)
				},
			}),
			openharness_delegate_status: toolFn({
				description: 'Check the status of a delegate job.',
				args: {
					id: z.string().describe('Job ID returned by openharness_delegate_start'),
				},
				async execute(args, ctx) {
					const job = await delegateService.refresh(args.id)
					refreshDelegateSummary(ctx.sessionID)
					if (!job) return `Job '${args.id}' not found.`
					return renderDelegateJob(job)
				},
			}),
			openharness_delegate_continue: toolFn({
				description: 'Send a follow-up prompt to a running session-backed delegate job.',
				args: {
					id: z.string().describe('Session-backed delegate job id'),
					prompt: z.string().describe('Follow-up prompt to send'),
					context: z.string().optional().describe('Optional extra context prepended to the follow-up prompt'),
				},
				async execute(args, ctx) {
					const job = await delegateService.continue(args.id, args.prompt, args.context)
					refreshDelegateSummary(ctx.sessionID)
					if (!job) return `Job '${args.id}' not found or does not support session continuation.`
					return renderDelegateJob(job)
				},
			}),
			openharness_delegate_cancel: toolFn({
				description: 'Cancel a delegate job and terminate active shell work when possible.',
				args: {
					id: z.string().describe('Delegate job id'),
				},
				async execute(args, ctx) {
					const job = await delegateService.cancel(args.id)
					refreshDelegateSummary(ctx.sessionID)
					if (!job) return `Job '${args.id}' not found.`
					return renderDelegateJob(job)
				},
			}),
			openharness_delegate_list: toolFn({
				description: 'List delegate jobs with optional status filter.',
				args: {
					status: z
						.enum(['pending', 'running', 'done', 'failed', 'cancelled'])
						.optional()
						.describe('Optional status filter'),
				},
				async execute(args, ctx) {
					const jobs = delegateService.list(args.status as any)
					await Promise.all(
						jobs.filter(job => job.mode === 'session').map(job => delegateService.refresh(job.id)),
					)
					const refreshed = delegateService.list(args.status as any)
					refreshDelegateSummary(ctx.sessionID)
					if (refreshed.length === 0)
						return args.status ? `No ${args.status} delegate jobs.` : 'No delegate jobs.'
					return refreshed
						.slice(-20)
						.map(j => `- ${j.id} [${j.status}/${j.mode}] ${j.label} (${j.kind})`)
						.join('\n')
				},
			}),
			openharness_delegate_audit: toolFn({
				description: 'Show delegate audit trail with recent bounded background jobs.',
				args: {},
				async execute(_args, ctx) {
					await Promise.all(
						delegateService
							.list()
							.filter(job => job.mode === 'session')
							.map(job => delegateService.refresh(job.id)),
					)
					refreshDelegateSummary(ctx.sessionID)
					return delegateService.renderAudit()
				},
			}),
			openharness_intel_outline: toolFn({
				description:
					'Show a read-only symbol outline for a file (AST-like: functions, classes, interfaces, types, exports).',
				args: {
					file: z.string().describe('Repo-local file path'),
				},
				async execute(args) {
					const outline = codeIntel.getOutline(args.file)
					if (!outline)
						return `No outline available for ${args.file} (file not found or code intel disabled).`
					const lines = [`## Outline: ${outline.filePath}`, `Lines: ${outline.lineCount}`, '']
					for (const sym of outline.symbols) {
						lines.push(`- L${sym.line} ${sym.kind} ${sym.name}${sym.isExported ? ' [exported]' : ''}`)
					}
					if (outline.symbols.length === 0) lines.push('No symbols found.')
					return lines.join('\n')
				},
			}),
			openharness_intel_definition: toolFn({
				description: 'Find the definition(s) of a symbol using graph-lite indexed exports.',
				args: {
					symbol: z.string().describe('Symbol name to search for'),
				},
				async execute(args) {
					const defs = codeIntel.findDefinition(args.symbol, graphLite)
					if (defs.length === 0)
						return `No definitions found for '${args.symbol}'. Ensure graph-lite is indexed.`
					return defs.map(d => `- ${d.symbolName} (${d.kind}) at ${d.filePath}:${d.line}`).join('\n')
				},
			}),
			openharness_intel_references: toolFn({
				description: 'Find all references to a symbol using rg (read-only, no LSP required).',
				args: {
					symbol: z.string().describe('Symbol name to search references for'),
					include: z.string().optional().describe('Optional glob pattern to filter files'),
					limit: z.number().optional().describe('Max results (default 50)'),
				},
				async execute(args) {
					const refs = codeIntel.findReferences(args.symbol, args.include, args.limit ?? 50)
					if (refs.length === 0) return `No references found for '${args.symbol}'. Requires rg.`
					return refs.map(r => `- ${r.filePath}:${r.line}:${r.column} ${r.text}`).join('\n')
				},
			}),
			openharness_intel_ast_search: toolFn({
				description:
					'Run read-only AST search via ast-grep/sg when available. Returns structural matches with file and range info.',
				args: {
					pattern: z.string().describe('ast-grep pattern to search for'),
					path: z.string().optional().describe('Optional repo-local file or subdirectory scope'),
					lang: z.string().optional().describe('Optional ast-grep language override, e.g. ts or js'),
					limit: z.number().optional().describe('Max results (default 50)'),
				},
				async execute(args, ctx) {
					const targetPath = args.path
						? toDisplayPath(ctx.directory, resolveRepoLocalPath(ctx.directory, args.path))
						: '.'
					const results = codeIntel.astSearch(args.pattern, {
						path: args.path,
						lang: args.lang,
						limit: args.limit ?? 50,
					})
					if (results === null)
						return 'AST search unavailable. Install `ast-grep` or `sg` and enable code intel.'
					if (results.length === 0) return `No AST matches found for pattern in ${targetPath}.`
					return results
						.map(
							match =>
								`- ${match.filePath}:${match.startLine}:${match.startColumn}-${match.endLine}:${match.endColumn} ${match.text.replace(/\s+/g, ' ').trim()}`,
						)
						.join('\n')
				},
			}),
			openharness_code_stats: toolFn({
				description:
					'Language and file statistics for the repo or a repo-local subdirectory. Uses tokei, then scc, then rg fallback.',
				args: {
					path: z.string().optional().describe('Optional repo-local subdirectory to analyze'),
				},
				async execute(args, ctx) {
					if (config.enableCodeStats !== true) return 'Code stats disabled by config.'
					const targetPath = args.path ? resolveRepoLocalPath(ctx.directory, args.path) : ctx.directory
					return getCodeStatsReport(targetPath)
				},
			}),
		},

		'tool.execute.before':
			config.enableHooks ||
			config.enableRtk ||
			config.enableSnapshots === true ||
			config.enableCommentChecker === true ||
			config.workflowMode === 'strict'
				? async (hookInput, output) => {
						maybeCaptureHarnessSnapshots(
							hookInput.tool,
							hookInput.sessionID,
							(output.args ?? {}) as Record<string, unknown>,
						)
						const workflowGate = workflowEngine.gateTool(
							hookInput.sessionID,
							hookInput.tool,
							(output.args ?? {}) as Record<string, unknown>,
						)
						if (!workflowGate.allowed) {
							syncWorkflowRuntime(hookInput.sessionID)
							throw new Error(formatWorkflowGateMessage(workflowGate, hookInput.tool))
						}
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

						applyCommentGuardrail(
							hookInput.sessionID,
							hookInput.tool,
							(output.args ?? {}) as Record<string, unknown>,
						)

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
									output.args = { ...output.args, command: compression.finalCommand }
								}
							}
						}

						// Host-side grep fast-path (T6)
						if (config.enableHostGrep !== false && hookInput.tool === 'grep') {
							const pattern = typeof output.args?.pattern === 'string' ? output.args.pattern : ''
							const include = typeof output.args?.include === 'string' ? output.args.include : undefined
							if (pattern) {
								const fastResult = hostGrepFastPath(cwd, pattern, include)
								if (fastResult !== null) {
									const rendered = renderGroupedGrepOutput(fastResult, {
										query: pattern,
										includePattern: include,
									})
									hostSearchResultsBySession.set(
										`${hookInput.sessionID}:${hookInput.callID}`,
										rendered,
									)
									trimSessionCache(hostSearchResultsBySession as any, MAX_HOST_SEARCH_CACHE)
								}
							}
						}

						// Host-side glob fast-path (T7)
						if (config.enableHostGlob !== false && hookInput.tool === 'glob') {
							const pattern = typeof output.args?.pattern === 'string' ? output.args.pattern : ''
							if (pattern) {
								const fastResult = hostGlobFastPath(cwd, pattern)
								if (fastResult !== null) {
									hostSearchResultsBySession.set(
										`${hookInput.sessionID}:${hookInput.callID}`,
										fastResult,
									)
									trimSessionCache(hostSearchResultsBySession as any, MAX_HOST_SEARCH_CACHE)
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
			checkpointManager.recordDecision(
				hookInput.sessionID,
				`${hookInput.tool}${hookInput.args ? ` ${truncateStr(JSON.stringify(hookInput.args), 120)}` : ''}`,
			)
			sessionState.addWorkLogEntry(
				`${hookInput.tool}${hookInput.args ? `: ${truncateStr(JSON.stringify(hookInput.args), 80)}` : ''}`,
			)
			if (hookInput.tool === 'read' && typeof hookInput.args?.filePath === 'string') {
				const delta = deltaReadManager.processRead(
					hookInput.sessionID,
					hookInput.args.filePath,
					toolOutput.output,
				)
				if (delta) toolOutput.output = delta
			}

			// --- Host-side grep/glob output replacement (T6/T7 V2) ---
			const hostResult = hostSearchResultsBySession.get(`${hookInput.sessionID}:${hookInput.callID}`)
			if (hostResult) {
				toolOutput.output = hostResult
				hostSearchResultsBySession.delete(`${hookInput.sessionID}:${hookInput.callID}`)
			}

			const archived = archiveManager.maybeArchive(hookInput.sessionID, hookInput.tool, toolOutput.output)
			if (archived) toolOutput.output = formatArchivedOutput(archived)

			// --- Quality signal tracking (T16) ---
			if (config.enableQualityScorer === true) {
				const signals = getOrCreateQualitySignals(hookInput.sessionID)
				if (hookInput.tool === 'read') {
					signals.repeatedReads += 1
				}
				if (hookInput.tool === 'grep' || hookInput.tool === 'glob') {
					signals.phaseCycles += 1
				}
				if (toolOutput.output && toolOutput.output.length > 5000) {
					signals.largeOutputCount += 1
				}
				if (archived) {
					signals.archivePressure += 1
				}
			}
			const touchedArtifacts = collectArtifactPaths(hookInput.tool, hookInput.args ?? {})
			if (touchedArtifacts.length > 0) {
				for (const artifact of touchedArtifacts) {
					sessionState.addArtifact(artifact)
					checkpointManager.recordFileActivity(hookInput.sessionID, artifact)
				}
				sessionRuntime.setCurrentTarget(touchedArtifacts[0] ?? '')
			}
			const workflowBefore = workflowEngine.getSnapshot(hookInput.sessionID)
			const rawCommand = typeof hookInput.args?.command === 'string' ? hookInput.args.command : ''
			const lockedValidationCommand = rawCommand
				? workflowEngine.resolveValidationCommand(hookInput.sessionID, rawCommand)
				: ''
			if (isWorkflowMutationTool(hookInput.tool) && workflowBefore?.phase === 'edit') {
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'EDIT_APPLIED',
					currentTarget: touchedArtifacts[0] ?? workflowBefore.currentTarget,
				})
			}
			if (
				hookInput.tool === 'bash' &&
				lockedValidationCommand &&
				(workflowBefore?.phase === 'run' || workflowBefore?.phase === 'verify')
			) {
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'RUN_COMPLETED',
					command: lockedValidationCommand,
				})
			}
			if (hookInput.tool === 'openharness_delegate_start' && typeof toolOutput.output === 'string') {
				const jobId = toolOutput.output.match(/^Job:\s*(\S+)/m)?.[1] ?? ''
				const kind =
					hookInput.args?.kind === 'index' ||
					hookInput.args?.kind === 'review' ||
					hookInput.args?.kind === 'research' ||
					hookInput.args?.kind === 'custom'
						? hookInput.args.kind
						: 'custom'
				if (jobId && workflowBefore?.phase === 'edit') {
					workflowEngine.dispatch(hookInput.sessionID, {
						type: 'DELEGATE_STARTED',
						jobId,
						kind,
						parentPhase: workflowBefore.phase,
					})
				}
			}
			if (
				(hookInput.tool === 'openharness_delegate_status' ||
					hookInput.tool === 'openharness_delegate_continue' ||
					hookInput.tool === 'openharness_delegate_cancel') &&
				typeof hookInput.args?.id === 'string'
			) {
				const job = await delegateService.refresh(hookInput.args.id)
				if (
					job &&
					(job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') &&
					workflowBefore?.phase.startsWith('delegate_')
				) {
					workflowEngine.dispatch(hookInput.sessionID, {
						type: 'DELEGATE_COMPLETED',
						jobId: job.id,
						status: job.status,
						result: job.status === 'failed' ? 'block' : 'advance',
					})
				}
			}
			if (
				config.enablePendingTodoReminders === true &&
				hookInput.tool === 'todowrite' &&
				Array.isArray(hookInput.args?.todos)
			) {
				const todos = hookInput.args.todos
					.filter((todo: unknown) => todo && typeof todo === 'object')
					.map((todo: unknown) => {
						const record = todo as { status?: unknown; content?: unknown }
						return { status: String(record.status ?? ''), content: String(record.content ?? '') }
					})
					.filter((todo: { status: string; content: string }) => todo.content.trim().length > 0)
				pendingTodos.update(hookInput.sessionID, todos)
				checkpointManager.updateTodos(hookInput.sessionID, todos)
			}
			maybeRecordVerificationState(sessionState, sessionRuntime, hookInput, toolOutput)
			const verification =
				classifyVerification({
					tool: hookInput.tool,
					args: hookInput.args ?? {},
					output: { output: toolOutput.output, metadata: toolOutput.metadata },
				}) ??
				(hookInput.tool === 'bash' && lockedValidationCommand
					? createVerificationRecord(
							lockedValidationCommand,
							typeof toolOutput.output === 'string' ? toolOutput.output : '',
							typeof toolOutput.metadata?.exitCode === 'number' ? toolOutput.metadata.exitCode : null,
						)
					: null)
			if (verification) {
				sessionRuntime.noteVerification(verification)
				checkpointManager.recordVerification(hookInput.sessionID, verification.summary)
				// Quality tracking for verification
				if (config.enableQualityScorer === true) {
					const signals = getOrCreateQualitySignals(hookInput.sessionID)
					if (verification.status === 'pass') signals.verificationPasses += 1
					if (verification.status === 'fail') signals.verificationFails += 1
				}
				// Checkpoint quality degradation trigger (T20)
				if (config.enableQualityScorer === true && config.enableProgressiveCheckpoints === true) {
					const qualityResult = scoreSessionQuality(hookInput.sessionID)
					if (qualityResult) {
						checkpointManager.maybeCaptureOnQuality(hookInput.sessionID, qualityResult.grade)
						const nudge = qualityScorer.getNudge(hookInput.sessionID, qualityResult)
						if (nudge) await appendPromptToSession(hookInput.sessionID, nudge.message)
					}
				}
				if (cavekitMutatorMode === 'opencode-integrated') {
					applyVerificationToSpec(
						sessionRuntime.snapshot().plan ??
							workflowEngine.getSnapshot(hookInput.sessionID)?.executionPlan ??
							null,
						verification,
					)
				}
				if (lockedValidationCommand && shouldDispatchVerification(verification.status)) {
					workflowEngine.dispatch(hookInput.sessionID, {
						type: 'VERIFY_COMPLETED',
						command: lockedValidationCommand,
						status: verification.status,
					})
				}
			}
			if (
				hookInput.tool === 'openharness_cavekit_backprop' &&
				workflowEngine.getSnapshot(hookInput.sessionID)?.phase === 'backprop'
			) {
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'BACKPROP_COMPLETED',
					outcome: 'blocked',
				})
			}
			maybeSetNextStep(sessionState, sessionRuntime, hookInput)
			syncWorkflowRuntime(hookInput.sessionID)
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
				// Track compaction for quality scoring
				if (config.enableQualityScorer === true) {
					const signals = getOrCreateQualitySignals(hookInput.sessionID)
					signals.compactionCount += 1
				}
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
				const restoreContext = checkpointManager.buildRestoreContext(hookInput.sessionID)
				const payload = buildCompactionPayload([formatted, restoreContext])
				if (payload) output.context.push(payload)
			}
		},

		'experimental.chat.system.transform': async (_input, output) => {
			const sessionID = _input.sessionID
			const cavemanState = getCavemanState(sessionID)
			if (sessionID) {
				refreshDoctorSummary(sessionID)
				if (config.enableQualityScorer === true) scoreSessionQuality(sessionID)
				refreshRecoverySummary(sessionID)
				syncWorkflowRuntime(sessionID)
			}
			const runtimeSnapshot = sessionID ? getSessionRuntime(sessionID).snapshot() : null
			if (sessionID && sessionPrimer.isEnabled()) {
				const runtimeSnap = sessionID ? getSessionRuntime(sessionID).snapshot() : null
				const primerSnapshot =
					sessionPrimerBySession.get(sessionID) ??
					sessionPrimer.buildSnapshot({
						cwd,
						planMode: runtimeSnap?.plan?.mode,
						currentTarget: runtimeSnap?.currentTarget,
						nextStep: runtimeSnap?.nextStep,
						graph: graphLite,
						pendingTodoCount:
							config.enablePendingTodoReminders === true ? pendingTodos.pending(sessionID).length : 0,
						latestVerificationStatus: runtimeSnap?.verificationRecords.at(-1)?.status ?? '',
						qualityGrade:
							config.enableQualityScorer === true
								? (() => {
										const signals = qualitySignalsBySession.get(sessionID)
										if (!signals) return ''
										return qualityScorer.score({
											repeatedReads: signals.repeatedReads,
											largeOutputCount: signals.largeOutputCount,
											archivePressure: signals.archivePressure,
											compactionCount: signals.compactionCount,
											verificationPassRate: signals.verificationPasses,
											verificationTotal: signals.verificationPasses + signals.verificationFails,
											todoPressure: pendingTodos.pending(sessionID).length,
											phaseCycles: signals.phaseCycles,
										}).grade
									})()
								: '',
					})
				output.system.push(sessionPrimer.render(primerSnapshot))
			}
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

			if (config.workflowMode === 'strict' && sessionID) {
				const workflowContract = workflowEngine.renderPhaseContract(sessionID)
				if (workflowContract) output.system.push(workflowContract)
			} else if (runtimeSnapshot?.plan) {
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
				sessionRetryManager.rememberPrompt(hookInput.sessionID, {
					messageID: hookInput.messageID ?? `retry-${Date.now()}`,
					text: prompt,
					agent: hookInput.agent,
					model: hookInput.model,
				})
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
				const primerSeed = sessionPrimer.buildSnapshot({
					cwd,
					planMode: sessionRuntime.snapshot().plan?.mode,
					currentTarget: sessionRuntime.snapshot().currentTarget,
					nextStep: sessionRuntime.snapshot().nextStep,
					graph: graphLite,
					pendingTodoCount:
						config.enablePendingTodoReminders === true
							? pendingTodos.pending(hookInput.sessionID).length
							: 0,
					latestVerificationStatus: sessionRuntime.snapshot().verificationRecords.at(-1)?.status ?? '',
				})
				sessionPrimerBySession.set(hookInput.sessionID, primerSeed)
				trimSessionCache(sessionPrimerBySession, MAX_SESSION_CACHE)
				const compiledPrompt = compileUserPrompt(prompt)
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'USER_GOAL_RECEIVED',
					goalHash: workflowEngine.createGoalHash(compiledPrompt.goal || compiledPrompt.normalized || prompt),
					workflowMode: config.workflowMode ?? 'advisory',
				})
				sessionRuntime.setCompiledPrompt(compiledPrompt)
				let planningRootContext = discoverRootContext(cwd, {
					claudeMd: config.enableClaudeMdContext !== false,
					agentsMd: config.enableAgentsMdContext !== false,
					spec: config.enableCavekitSpecContext !== false,
				})
				if (config.workflowMode === 'strict' && fileExists(resolveCaveKitSpecPath(cwd))) {
					try {
						const strictBuild = buildCaveKitPlan(cwd, {
							focus: prompt,
							limit: 3,
							markActive: true,
						})
						planningRootContext = planningRootContext.map(ctx =>
							ctx.label === 'CaveKit Spec'
								? { ...ctx, content: strictBuild.content, source: strictBuild.path }
								: ctx,
						)
					} catch {
						// keep advisory-style root context when strict build cannot be prepared
					}
				}
				const planningMemories = config.enableMemory
					? await recallProjectMemories(prompt, cwd, hookInput.sessionID, 3)
					: []
				const discoveryHints = primerSeed.topFiles
				const graphStatus = graphLite.getStatus()
				const graphReady = graphStatus.ready
				const graphCochangeHints =
					graphReady && discoveryHints.length > 0
						? graphLite.getCoChangeHints(discoveryHints[0], 3).map(h => ({ path: h.path, score: h.score }))
						: []
				const graphBlastRadiusFiles =
					graphReady && discoveryHints.length > 0
						? graphLite.getBlastRadiusDetail(discoveryHints[0]).files.slice(0, 3)
						: []
				const graphSymbolMatches =
					graphReady && compiledPrompt.keywords.length > 0
						? compiledPrompt.keywords
								.slice(0, 2)
								.flatMap(kw =>
									graphLite
										.searchSymbols(kw, 3)
										.map(r => ({ symbolName: r.symbol.name, filePath: r.filePath })),
								)
						: []
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'CONTEXT_READY',
					currentTarget: discoveryHints[0] ?? graphBlastRadiusFiles[0] ?? graphCochangeHints[0]?.path ?? '',
				})
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'PROMPT_COMPILED',
					compiledPrompt,
				})
				const sessionState = getSessionState(hookInput.sessionID)
				const plan = buildExecutionPlan({
					compiledPrompt,
					rootContext: planningRootContext,
					memories: planningMemories,
					taskFocus: sessionState.getTaskFocus(),
					discoveryHints,
					graphCochangeHints,
					graphBlastRadiusFiles,
					graphSymbolMatches,
				})
				sessionRuntime.setPlan(plan)
				workflowEngine.dispatch(hookInput.sessionID, {
					type: 'PLAN_READY',
					plan,
				})
				sessionState.updateGoal(plan.goal)
				setSessionNextStep(
					hookInput.sessionID,
					plan.steps[0]?.title ?? 'Apply next planned step and verify result.',
				)
				sessionPrimerBySession.set(
					hookInput.sessionID,
					sessionPrimer.buildSnapshot({
						cwd,
						planMode: plan.mode,
						currentTarget: plan.steps[0]?.title ?? sessionRuntime.snapshot().currentTarget,
						nextStep: plan.steps[0]?.title ?? sessionRuntime.snapshot().nextStep,
						graph: graphLite,
						pendingTodoCount:
							config.enablePendingTodoReminders === true
								? pendingTodos.pending(hookInput.sessionID).length
								: 0,
						latestVerificationStatus: sessionRuntime.snapshot().verificationRecords.at(-1)?.status ?? '',
					}),
				)
				trimSessionCache(sessionPrimerBySession, MAX_SESSION_CACHE)
				syncWorkflowRuntime(hookInput.sessionID)
			} else if (hookInput.messageID) {
				getSessionState(hookInput.sessionID)
				getSessionRuntime(hookInput.sessionID)
				syncWorkflowRuntime(hookInput.sessionID)
			}
		},

		event: async ({ event }) => {
			const type = event.type as string
			const sessionId = extractSessionId(event)
			if (type === 'session.error' && sessionId) {
				const sourcePhase = workflowEngine.getSnapshot(sessionId)?.phase
				workflowEngine.dispatch(sessionId, {
					type: 'RECOVERY_REQUIRED',
					classification: sessionRecoveryManager.classifyError(event as Record<string, unknown>),
					sourcePhase,
				})
				if (config.enableSessionRecovery === true) {
					const lastRetryPrompt = lastPromptBySession.has(sessionId)
						? { messageID: `recovery-${Date.now()}`, text: lastPromptBySession.get(sessionId) ?? '' }
						: undefined
					const recovered = await sessionRecoveryManager.handleSessionError(
						event as Record<string, unknown>,
						sessionId,
						lastRetryPrompt,
					)
					workflowEngine.dispatch(sessionId, {
						type: 'RECOVERY_COMPLETED',
						success: recovered,
						restorePhase: sourcePhase,
						message: recovered ? 'recovery restored prior phase' : 'recovery exhausted retry budget',
					})
					refreshRecoverySummary(sessionId)
				} else {
					await sessionRetryManager.handleSessionError(event as Record<string, unknown>, sessionId)
					workflowEngine.dispatch(sessionId, {
						type: 'RECOVERY_COMPLETED',
						success: false,
						restorePhase: sourcePhase,
						message: 'session recovery disabled; retry manager handled the error',
					})
				}
				syncWorkflowRuntime(sessionId)
			}
			if (config.enableCavememBridge !== false && type === 'session.created' && sessionId) {
				startCaveMemSession(sessionId, cwd, getCaveMemRuntimeOptions(sessionId))
				getSessionRuntime(sessionId).setMemorySessionPointer(`cavemem://session/${sessionId}`)
			}
			if (type === 'session.created' && sessionId) {
				const runtime = getSessionRuntime(sessionId)
				runtime.setPhase('load-context')
				runtime.setMemoryProtocol(describeMemoryProtocol())
				refreshDoctorSummary(sessionId)
				syncWorkflowRuntime(sessionId)
			}

			if (
				config.enablePendingTodoReminders === true &&
				(type === 'todo.updated' || type === 'todos.updated') &&
				sessionId
			) {
				const todos = extractPendingTodos(event)
				pendingTodos.update(sessionId, todos)
				checkpointManager.updateTodos(sessionId, todos)
			}

			if (
				config.enablePendingTodoReminders === true &&
				(type === 'session.idle' || type === 'session.completed') &&
				sessionId
			) {
				const reminder = pendingTodos.buildReminder(sessionId)
				if (reminder) await appendPromptToSession(sessionId, reminder)
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
				workflowEngine.clear(sessionId)
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
	if (!/^(?:\[|{)/.test(input)) return null
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
	const workflowPhase = snapshot.workflow?.phase
		? getWorkflowPhaseLabel(snapshot.workflow.phase).replace(/\s+/g, '_')
		: ''
	const parts = [`session=${sessionID}`, `phase=${workflowPhase || snapshot.phase}`]
	if (snapshot.plan) parts.push(`mode=${snapshot.plan.mode}`, `goal=${truncateStr(snapshot.plan.goal, 80)}`)
	if (snapshot.workflow?.workflowMode) parts.push(`workflow=${snapshot.workflow.workflowMode}`)
	if (snapshot.nextStep) parts.push(`next=${truncateStr(snapshot.nextStep, 80)}`)
	if (snapshot.currentTarget) parts.push(`target=${truncateStr(snapshot.currentTarget, 80)}`)
	if (snapshot.memoryProtocol) parts.push(`memproto=${snapshot.memoryProtocol}`)
	if (snapshot.memorySessionPointer) parts.push(`memory=${snapshot.memorySessionPointer}`)
	if (snapshot.doctorSummary) parts.push(`doctor=${truncateStr(snapshot.doctorSummary, 60)}`)
	if (snapshot.qualitySummary) parts.push(`quality=${truncateStr(snapshot.qualitySummary, 60)}`)
	if (snapshot.recoverySummary) parts.push(`recovery=${truncateStr(snapshot.recoverySummary, 60)}`)
	if (snapshot.verificationRecords.length > 0) {
		const lastVerification = snapshot.verificationRecords[snapshot.verificationRecords.length - 1]
		parts.push(`verify=${lastVerification.status}:${truncateStr(lastVerification.command, 60)}`)
	}
	parts.push(`telemetry=${formatTelemetrySummary(snapshot)}`)
	return `Runtime ops summary | ${parts.join(' | ')}`
}

function extractPendingTodos(event: Record<string, unknown>): Array<{ status: string; content: string }> {
	const properties = event.properties
	if (!properties || typeof properties !== 'object') return []
	const raw = (properties as Record<string, unknown>).todos
	if (!Array.isArray(raw)) return []
	return raw
		.filter((entry: unknown) => entry && typeof entry === 'object')
		.map((entry: unknown) => {
			const todo = entry as { status?: unknown; content?: unknown }
			return { status: String(todo.status ?? ''), content: String(todo.content ?? '') }
		})
		.filter((entry: { status: string; content: string }) => entry.content.trim().length > 0)
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
