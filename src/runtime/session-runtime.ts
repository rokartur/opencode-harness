import type {
	CompressionTelemetryLayer,
	CompiledPrompt,
	ExecutionPhase,
	ExecutionPlan,
	SessionCompressionTelemetry,
	SessionRuntimeSnapshot,
	ToolCompressionRecord,
	ToolCompressionTelemetryLayer,
	VerificationRecord,
} from './types.js'

export class SessionRuntimeTracker {
	private phase: ExecutionPhase = 'load-context'
	private compiledPrompt: CompiledPrompt | null = null
	private plan: ExecutionPlan | null = null
	private nextStep = ''
	private currentTarget = ''
	private memoryProtocol = ''
	private memorySessionPointer = ''
	private delegateSummary = ''
	private commentSummary = ''
	private doctorSummary = ''
	private qualitySummary = ''
	private recoverySummary = ''
	private telemetry: SessionCompressionTelemetry = createEmptyTelemetry()
	private verificationSummary: string[] = []
	private verificationRecords: VerificationRecord[] = []
	private startedAt = Date.now()
	private updatedAt = Date.now()

	setPhase(phase: ExecutionPhase): void {
		this.phase = phase
		this.updatedAt = Date.now()
	}

	setCompiledPrompt(compiledPrompt: CompiledPrompt): void {
		this.compiledPrompt = compiledPrompt
		this.phase = 'compile-prompt'
		this.updatedAt = Date.now()
	}

	setPlan(plan: ExecutionPlan): void {
		this.plan = plan
		this.phase = 'plan'
		this.nextStep = plan.steps[0]?.title ?? this.nextStep
		this.currentTarget = plan.steps[0]?.title ?? this.currentTarget
		this.updatedAt = Date.now()
	}

	setNextStep(nextStep: string): void {
		this.nextStep = nextStep.trim()
		this.updatedAt = Date.now()
	}

	setCurrentTarget(currentTarget: string): void {
		const normalized = currentTarget.trim()
		if (!normalized) return
		this.currentTarget = normalized
		this.updatedAt = Date.now()
	}

	setMemorySessionPointer(pointer: string): void {
		this.memorySessionPointer = pointer.trim()
		this.updatedAt = Date.now()
	}

	setMemoryProtocol(protocol: string): void {
		this.memoryProtocol = protocol.trim()
		this.updatedAt = Date.now()
	}

	setDelegateSummary(summary: string): void {
		this.delegateSummary = summary.trim()
		this.updatedAt = Date.now()
	}

	setCommentSummary(summary: string): void {
		this.commentSummary = summary.trim()
		this.updatedAt = Date.now()
	}

	setDoctorSummary(summary: string): void {
		this.doctorSummary = summary.trim()
		this.updatedAt = Date.now()
	}

	setQualitySummary(summary: string): void {
		this.qualitySummary = summary.trim()
		this.updatedAt = Date.now()
	}

	setRecoverySummary(summary: string): void {
		this.recoverySummary = summary.trim()
		this.updatedAt = Date.now()
	}

	notePromptCompression(baselineChars: number, compressedChars: number): void {
		recordTelemetry(this.telemetry.l01Prompt, baselineChars, compressedChars)
		this.updatedAt = Date.now()
	}

	noteToolCompression(record: ToolCompressionRecord): void {
		recordToolCompression(this.telemetry.l02Tool, record)
		this.updatedAt = Date.now()
	}

	noteOutputCompression(baselineChars: number, compressedChars: number): void {
		recordTelemetry(this.telemetry.l03Output, baselineChars, compressedChars)
		this.updatedAt = Date.now()
	}

	noteContextCompression(baselineChars: number, compressedChars: number): void {
		recordTelemetry(this.telemetry.l04Context, baselineChars, compressedChars)
		this.updatedAt = Date.now()
	}

	noteVerification(record: VerificationRecord): void {
		if (!record.summary) return
		this.verificationSummary.push(record.summary)
		if (this.verificationSummary.length > 6) this.verificationSummary.shift()
		this.verificationRecords.push(record)
		if (this.verificationRecords.length > 12) this.verificationRecords.shift()
		this.phase = 'verify'
		this.updatedAt = Date.now()
	}

	noteTool(tool: string, args: unknown): void {
		if (
			tool === 'read' ||
			tool === 'glob' ||
			tool === 'grep' ||
			tool.startsWith('openharness_graph_') ||
			tool.startsWith('openharness_intel_')
		) {
			this.phase = 'load-context'
		} else if (tool === 'bash') {
			const rawCommand = (args as { command?: unknown })?.command
			const command = typeof rawCommand === 'string' ? rawCommand : ''
			this.phase = /\b(test|build|check|lint|typecheck)\b/.test(command) ? 'run-tests' : 'edit'
		} else {
			this.phase = 'edit'
		}
		this.updatedAt = Date.now()
	}

	snapshot(): SessionRuntimeSnapshot {
		return {
			phase: this.phase,
			compiledPrompt: this.compiledPrompt,
			plan: this.plan,
			nextStep: this.nextStep,
			currentTarget: this.currentTarget,
			memoryProtocol: this.memoryProtocol,
			memorySessionPointer: this.memorySessionPointer,
			delegateSummary: this.delegateSummary,
			commentSummary: this.commentSummary,
			doctorSummary: this.doctorSummary,
			qualitySummary: this.qualitySummary,
			recoverySummary: this.recoverySummary,
			telemetry: cloneTelemetry(this.telemetry),
			verificationSummary: [...this.verificationSummary],
			verificationRecords: [...this.verificationRecords],
			startedAt: this.startedAt,
			updatedAt: this.updatedAt,
		}
	}

	reset(): void {
		this.phase = 'load-context'
		this.compiledPrompt = null
		this.plan = null
		this.nextStep = ''
		this.currentTarget = ''
		this.memoryProtocol = ''
		this.memorySessionPointer = ''
		this.delegateSummary = ''
		this.commentSummary = ''
		this.doctorSummary = ''
		this.qualitySummary = ''
		this.recoverySummary = ''
		this.telemetry = createEmptyTelemetry()
		this.verificationSummary = []
		this.verificationRecords = []
		this.startedAt = Date.now()
		this.updatedAt = Date.now()
	}
}

function createEmptyTelemetry(): SessionCompressionTelemetry {
	return {
		l01Prompt: createEmptyLayer(),
		l02Tool: createEmptyToolLayer(),
		l03Output: createEmptyLayer(),
		l04Context: createEmptyLayer(),
	}
}

function createEmptyLayer(): CompressionTelemetryLayer {
	return {
		baselineChars: 0,
		compressedChars: 0,
		savedChars: 0,
		sampleCount: 0,
		lastBaselineChars: 0,
		lastCompressedChars: 0,
		lastSavedChars: 0,
	}
}

function createEmptyToolLayer(): ToolCompressionTelemetryLayer {
	return {
		...createEmptyLayer(),
		rewrittenCount: 0,
		proxiedCount: 0,
		skippedCount: 0,
		unavailableCount: 0,
		lastMode: '',
		lastReason: '',
	}
}

function recordTelemetry(layer: CompressionTelemetryLayer, baselineChars: number, compressedChars: number): void {
	const baseline = Math.max(0, baselineChars)
	const compressed = Math.max(0, compressedChars)
	const saved = baseline - compressed
	layer.baselineChars += baseline
	layer.compressedChars += compressed
	layer.savedChars += saved
	layer.sampleCount += 1
	layer.lastBaselineChars = baseline
	layer.lastCompressedChars = compressed
	layer.lastSavedChars = saved
}

function recordToolCompression(layer: ToolCompressionTelemetryLayer, record: ToolCompressionRecord): void {
	layer.lastMode = record.mode
	layer.lastReason = record.reason.trim()
	if (record.mode === 'rewritten') {
		recordTelemetry(layer, record.baselineChars, record.compressedChars)
		layer.rewrittenCount += 1
		return
	}
	if (record.mode === 'proxied') {
		layer.proxiedCount += 1
		return
	}
	if (record.mode === 'unavailable') {
		layer.unavailableCount += 1
		return
	}
	layer.skippedCount += 1
}

function cloneTelemetry(telemetry: SessionCompressionTelemetry): SessionCompressionTelemetry {
	return {
		l01Prompt: { ...telemetry.l01Prompt },
		l02Tool: { ...telemetry.l02Tool },
		l03Output: { ...telemetry.l03Output },
		l04Context: { ...telemetry.l04Context },
	}
}
