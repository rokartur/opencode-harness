import type {
	CompiledPrompt,
	ExecutionPhase,
	ExecutionPlan,
	SessionRuntimeSnapshot,
	VerificationRecord,
} from './types.js'

export class SessionRuntimeTracker {
	private phase: ExecutionPhase = 'load-context'
	private compiledPrompt: CompiledPrompt | null = null
	private plan: ExecutionPlan | null = null
	private verificationSummary: string[] = []
	private verificationRecords: VerificationRecord[] = []
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
		if (tool === 'read' || tool === 'glob') {
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
			verificationSummary: [...this.verificationSummary],
			verificationRecords: [...this.verificationRecords],
			updatedAt: this.updatedAt,
		}
	}

	reset(): void {
		this.phase = 'load-context'
		this.compiledPrompt = null
		this.plan = null
		this.verificationSummary = []
		this.verificationRecords = []
		this.updatedAt = Date.now()
	}
}
