import type { CompiledPrompt, ExecutionMode, ExecutionPlan, VerificationStatus } from './types.js'

export type WorkflowPhase =
	| 'idle'
	| 'load_context'
	| 'compile_prompt'
	| 'plan'
	| 'edit'
	| 'run'
	| 'verify'
	| 'backprop'
	| 'done'
	| 'blocked'
	| 'recovery'
	| 'cancelled'
	| 'delegate_research'
	| 'delegate_review'
	| 'delegate_index'

export type WorkflowRuntimeMode = 'advisory' | 'strict'
export type WorkflowVerificationStatus = VerificationStatus | ''

export interface WorkflowWorkPacket {
	goal: string
	mode: ExecutionMode
	selectedTaskIds: string[]
	currentTarget: string
	sourceArtifacts: string[]
	acceptanceCriteria: string[]
	validationCommands: string[]
	exitCondition: string
}

export interface WorkflowState {
	sessionID: string
	phase: WorkflowPhase
	goalHash: string
	mode: ExecutionMode
	selectedTaskIds: string[]
	currentTarget: string
	nextRequiredAction: string
	allowedTools: string[]
	validationCommands: string[]
	verificationStatus: WorkflowVerificationStatus
	blockedReason: string
	lastTransition: string
	delegateChildren: string[]
	recoveryState: string
	specSyncStatus: string
	workflowMode: WorkflowRuntimeMode
	workPacket: WorkflowWorkPacket | null
	executionPlan: ExecutionPlan | null
	compiledPrompt: CompiledPrompt | null
	completedValidationCommands: string[]
	validationResults: Record<string, VerificationStatus>
	recoverySourcePhase: WorkflowPhase | ''
	delegateParentPhase: WorkflowPhase | ''
	lastEvent: string
}

export interface WorkflowStatusSnapshot extends WorkflowState {
	exitCondition: string
	verifyContract: string[]
}

export type WorkflowEvent =
	| {
			type: 'USER_GOAL_RECEIVED'
			goalHash: string
			workflowMode: WorkflowRuntimeMode
	  }
	| {
			type: 'CONTEXT_READY'
			currentTarget?: string
	  }
	| {
			type: 'PROMPT_COMPILED'
			compiledPrompt: CompiledPrompt
	  }
	| {
			type: 'PLAN_READY'
			plan: ExecutionPlan
			workPacket?: WorkflowWorkPacket
	  }
	| {
			type: 'READ_COMPLETED'
			target?: string
			tool?: string
	  }
	| {
			type: 'GRAPH_HINTS_UPDATED'
			currentTarget?: string
			summary?: string
	  }
	| {
			type: 'EDIT_APPLIED'
			currentTarget?: string
			noOp?: boolean
	  }
	| {
			type: 'RUN_COMPLETED'
			command: string
	  }
	| {
			type: 'VERIFY_COMPLETED'
			command: string
			status: VerificationStatus
	  }
	| {
			type: 'BACKPROP_COMPLETED'
			outcome?: 'edit' | 'done' | 'blocked'
			message?: string
	  }
	| {
			type: 'DELEGATE_STARTED'
			jobId: string
			kind: 'index' | 'review' | 'research' | 'custom'
			parentPhase?: WorkflowPhase
	  }
	| {
			type: 'DELEGATE_FINISHED'
			jobId: string
			status: 'done' | 'failed' | 'cancelled'
			resumePhase?: WorkflowPhase
			result?: 'advance' | 'block' | 'reopen'
	  }
	| {
			type: 'DELEGATE_COMPLETED'
			jobId: string
			status: 'done' | 'failed' | 'cancelled'
			resumePhase?: WorkflowPhase
			result?: 'advance' | 'block' | 'reopen'
	  }
	| {
			type: 'RECOVERY_REQUIRED'
			classification?: string
			sourcePhase?: WorkflowPhase
	  }
	| {
			type: 'RECOVERY_COMPLETED'
			success: boolean
			restorePhase?: WorkflowPhase
			message?: string
	  }
	| {
			type: 'WORKFLOW_CANCELLED'
			reason?: string
	  }

export interface WorkflowToolGateResult {
	allowed: boolean
	phase: WorkflowPhase
	allowedTools: string[]
	nextRequiredAction: string
	exitCondition: string
	reason: string
}

const STATUS_TOOLS = [
	'openharness_runtime_status',
	'openharness_caveman_stack_status',
	'openharness_diagnostics',
	'openharness_doctor',
	'openharness_quality',
	'openharness_memory_stats',
	'openharness_telemetry_snapshot',
	'openharness_benchmark_snapshot',
	'openharness_recovery_audit',
	'openharness_delegate_status',
	'openharness_delegate_list',
	'openharness_delegate_audit',
	'openharness_skill',
	'openharness_workflow_control',
]

export function createWorkflowState(sessionID: string, workflowMode: WorkflowRuntimeMode = 'advisory'): WorkflowState {
	const phase: WorkflowPhase = 'idle'
	return {
		sessionID,
		phase,
		goalHash: '',
		mode: 'ad-hoc',
		selectedTaskIds: [],
		currentTarget: '',
		nextRequiredAction: describeNextRequiredAction(phase, []),
		allowedTools: getAllowedToolsForPhase(phase),
		validationCommands: [],
		verificationStatus: '',
		blockedReason: '',
		lastTransition: 'initialized',
		delegateChildren: [],
		recoveryState: '',
		specSyncStatus: '',
		workflowMode,
		workPacket: null,
		executionPlan: null,
		compiledPrompt: null,
		completedValidationCommands: [],
		validationResults: {},
		recoverySourcePhase: '',
		delegateParentPhase: '',
		lastEvent: '',
	}
}

export function normalizeWorkflowState(
	input: Partial<WorkflowState> & Pick<WorkflowState, 'sessionID'>,
	fallbackMode: WorkflowRuntimeMode = 'advisory',
): WorkflowState {
	const base = createWorkflowState(input.sessionID, input.workflowMode ?? fallbackMode)
	const phase = input.phase ?? base.phase
	const validationCommands = uniqueStrings(input.validationCommands ?? base.validationCommands)
	const workPacket = input.workPacket ?? (input.executionPlan ? buildWorkflowWorkPacket(input.executionPlan) : null)
	return {
		...base,
		...input,
		phase,
		mode: input.mode ?? input.executionPlan?.mode ?? base.mode,
		selectedTaskIds: uniqueStrings(input.selectedTaskIds ?? workPacket?.selectedTaskIds ?? base.selectedTaskIds),
		currentTarget: input.currentTarget ?? workPacket?.currentTarget ?? base.currentTarget,
		validationCommands,
		workflowMode: input.workflowMode ?? fallbackMode,
		allowedTools: getAllowedToolsForPhase(phase),
		workPacket,
		completedValidationCommands: uniqueStrings(
			input.completedValidationCommands ?? base.completedValidationCommands,
		),
		validationResults: { ...(input.validationResults ?? base.validationResults) },
		nextRequiredAction:
			input.nextRequiredAction && input.nextRequiredAction.trim().length > 0
				? input.nextRequiredAction
				: describeNextRequiredAction(phase, validationCommands),
		lastTransition: input.lastTransition ?? base.lastTransition,
		delegateChildren: uniqueStrings(input.delegateChildren ?? base.delegateChildren),
		recoveryState: input.recoveryState ?? base.recoveryState,
		specSyncStatus: input.specSyncStatus ?? base.specSyncStatus,
		verificationStatus: input.verificationStatus ?? base.verificationStatus,
		blockedReason: input.blockedReason ?? base.blockedReason,
		recoverySourcePhase: input.recoverySourcePhase ?? base.recoverySourcePhase,
		delegateParentPhase: input.delegateParentPhase ?? base.delegateParentPhase,
		lastEvent: input.lastEvent ?? base.lastEvent,
	}
}

export function buildWorkflowWorkPacket(plan: ExecutionPlan): WorkflowWorkPacket {
	const selectedTaskIds = uniqueStrings(plan.steps.map(step => step.id).filter(id => /^T\d+$/i.test(id)))
	const acceptanceCriteria = uniqueStrings(plan.steps.flatMap(step => step.acceptance)).slice(0, 12)
	const currentTarget = plan.steps[0]?.title ?? plan.goal
	const validationCommands = uniqueStrings(plan.validationCommands)
	return {
		goal: plan.goal,
		mode: plan.mode,
		selectedTaskIds,
		currentTarget,
		sourceArtifacts: uniqueStrings(plan.sourceArtifacts),
		acceptanceCriteria,
		validationCommands,
		exitCondition: buildWorkPacketExitCondition(validationCommands),
	}
}

export function toWorkflowStatusSnapshot(state: WorkflowState): WorkflowStatusSnapshot {
	const normalized = normalizeWorkflowState(state, state.workflowMode)
	return {
		...normalized,
		exitCondition: getWorkflowExitCondition(normalized),
		verifyContract: [...normalized.validationCommands],
	}
}

export function getAllowedToolsForPhase(phase: WorkflowPhase): string[] {
	switch (phase) {
		case 'idle':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'openharness_graph_*',
				'openharness_intel_*',
			])
		case 'load_context':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'openharness_graph_*',
				'openharness_intel_*',
				'openharness_cavemem_recall',
				'cavemem_*',
			])
		case 'compile_prompt':
			return [...STATUS_TOOLS]
		case 'plan':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'openharness_graph_*',
				'openharness_intel_*',
				'openharness_cavemem_recall',
				'cavemem_*',
				'openharness_cavekit_build',
				'openharness_cavekit_check',
			])
		case 'edit':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'write',
				'edit',
				'openharness_patch',
				'openharness_caveman_compress_file',
				'openharness_delegate_start',
			])
		case 'run':
			return uniqueStrings([...STATUS_TOOLS, 'bash'])
		case 'verify':
			return uniqueStrings([...STATUS_TOOLS, 'bash', 'openharness_cavekit_check', 'openharness_cavekit_backprop'])
		case 'backprop':
			return uniqueStrings([...STATUS_TOOLS, 'openharness_cavekit_backprop', 'openharness_cavekit_spec'])
		case 'done':
		case 'blocked':
		case 'cancelled':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'openharness_graph_*',
				'openharness_intel_*',
				'openharness_cavekit_check',
			])
		case 'recovery':
			return [...STATUS_TOOLS]
		case 'delegate_research':
		case 'delegate_review':
		case 'delegate_index':
			return uniqueStrings([
				...STATUS_TOOLS,
				'read',
				'glob',
				'grep',
				'openharness_delegate_continue',
				'openharness_delegate_cancel',
			])
	}
}

export function getWorkflowExitCondition(state: WorkflowState): string {
	switch (state.phase) {
		case 'idle':
			return 'Receive a user goal to initialize a workflow.'
		case 'load_context':
			return 'Context bundle is ready and tool availability is recorded.'
		case 'compile_prompt':
			return 'Canonical compiled prompt exists with goal, constraints, and keywords.'
		case 'plan':
			return 'Locked work packet exists with selected tasks, acceptance criteria, and validation commands.'
		case 'edit':
			return 'Apply a repo mutation or record a deliberate no-op before moving to run.'
		case 'run':
			return state.validationCommands.length > 0
				? `Run locked validation commands: ${state.validationCommands.join(' ; ')}`
				: 'Collect execution records for the planned verification commands.'
		case 'verify': {
			const remaining = getRemainingValidationCommands(state)
			return remaining.length > 0
				? `Evaluate verification records and run remaining locked commands: ${remaining.join(' ; ')}`
				: 'Resolve verification deterministically to pass, fail, flaky, or unknown.'
		}
		case 'backprop':
			return 'Backprop fail/flaky verification into SPEC/runtime state before retry, close, or block.'
		case 'done':
			return 'Workflow is complete.'
		case 'blocked':
			return state.blockedReason || 'Workflow is blocked until user intervention.'
		case 'recovery':
			return 'Recovery must restore the exact source phase or transition to blocked.'
		case 'cancelled':
			return 'Start a new user goal to begin another workflow.'
		case 'delegate_research':
		case 'delegate_review':
		case 'delegate_index':
			return 'Delegate result must be recorded before the parent workflow resumes.'
	}
}

export function getWorkflowPhaseLabel(phase: WorkflowPhase): string {
	return phase.replace(/_/g, ' ')
}

export function matchesAllowedWorkflowTool(toolName: string, allowedTools: string[]): boolean {
	return allowedTools.some(pattern => {
		if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1))
		return toolName === pattern
	})
}

export function getRemainingValidationCommands(
	state: Pick<WorkflowState, 'validationCommands' | 'completedValidationCommands'>,
): string[] {
	const completed = new Set(state.completedValidationCommands.map(normalizeWorkflowCommand))
	return state.validationCommands.filter(command => !completed.has(normalizeWorkflowCommand(command)))
}

export function normalizeWorkflowCommand(command: string): string {
	return command.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function resolveLockedValidationCommand(command: string, validationCommands: string[]): string {
	const normalized = normalizeWorkflowCommand(command)
	for (const candidate of validationCommands) {
		const normalizedCandidate = normalizeWorkflowCommand(candidate)
		if (!normalizedCandidate) continue
		if (normalized === normalizedCandidate) return candidate
		if (normalized.includes(normalizedCandidate)) return candidate
	}
	return ''
}

function describeNextRequiredAction(phase: WorkflowPhase, validationCommands: string[]): string {
	switch (phase) {
		case 'idle':
			return 'Wait for a user goal.'
		case 'load_context':
			return 'Gather repo context, memory, and graph hints.'
		case 'compile_prompt':
			return 'Compile the goal into a canonical prompt.'
		case 'plan':
			return 'Lock a work packet before editing.'
		case 'edit':
			return 'Apply the smallest correct repo change.'
		case 'run':
			return validationCommands.length > 0
				? `Run locked validation: ${validationCommands.join(' ; ')}`
				: 'Run the planned validation commands.'
		case 'verify':
			return 'Evaluate verification against acceptance criteria.'
		case 'backprop':
			return 'Backprop the failing verification before retrying or closing.'
		case 'done':
			return 'Summarize the verified result or start a new goal.'
		case 'blocked':
			return 'Resolve the blocked reason or restart the workflow.'
		case 'recovery':
			return 'Wait for bounded recovery to finish.'
		case 'cancelled':
			return 'Start a new goal to resume work.'
		case 'delegate_research':
		case 'delegate_review':
		case 'delegate_index':
			return 'Wait for delegate completion or continue/cancel the delegate.'
	}
}

function buildWorkPacketExitCondition(validationCommands: string[]): string {
	return validationCommands.length > 0
		? `Apply the planned change and reach verify=pass for ${validationCommands.join(' ; ')}.`
		: 'Apply the planned change and record a deterministic verification outcome.'
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter(value => value.trim().length > 0)))
}
