export type ConstraintKind = 'must' | 'avoid' | 'prefer' | 'use' | 'scope'

export interface PromptConstraint {
	kind: ConstraintKind
	text: string
}

export interface CompiledPrompt {
	raw: string
	normalized: string
	goal: string
	constraints: PromptConstraint[]
	keywords: string[]
}

export type ExecutionMode = 'spec-driven' | 'ad-hoc'
export type ExecutionPhase = 'load-context' | 'compile-prompt' | 'plan' | 'edit' | 'run-tests' | 'verify'
export type ExecutionStepKind = 'inspect' | 'edit' | 'verify'

export interface ExecutionStep {
	id: string
	kind: ExecutionStepKind
	title: string
	reason: string
	citations: string[]
	acceptance: string[]
}

export interface ExecutionPlan {
	mode: ExecutionMode
	goal: string
	summary: string
	steps: ExecutionStep[]
	sourceArtifacts: string[]
	specSource: string
	memoryRefs: string[]
	validationCommands: string[]
}

export type VerificationStatus = 'pass' | 'fail' | 'flaky' | 'unknown'

export interface VerificationRecord {
	command: string
	status: VerificationStatus
	summary: string
	exitCode: number | null
	timestamp: number
}

export interface SessionRuntimeSnapshot {
	phase: ExecutionPhase
	compiledPrompt: CompiledPrompt | null
	plan: ExecutionPlan | null
	verificationSummary: string[]
	verificationRecords: VerificationRecord[]
	updatedAt: number
}
