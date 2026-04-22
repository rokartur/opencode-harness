import type { VerificationStatus } from './types.js'
import {
	buildWorkflowWorkPacket,
	createWorkflowState,
	getAllowedToolsForPhase,
	getRemainingValidationCommands,
	normalizeWorkflowState,
	type WorkflowEvent,
	type WorkflowPhase,
	type WorkflowState,
} from './workflow-types.js'

export function reduceWorkflow(currentState: WorkflowState, event: WorkflowEvent): WorkflowState {
	const current = normalizeWorkflowState(currentState, currentState.workflowMode)

	switch (event.type) {
		case 'USER_GOAL_RECEIVED':
			return transition(
				createWorkflowState(current.sessionID, event.workflowMode),
				'load_context',
				`goal received (${event.goalHash.slice(0, 12) || 'n/a'})`,
				{
					goalHash: event.goalHash,
					workflowMode: event.workflowMode,
					specSyncStatus: '',
				},
			)

		case 'READ_COMPLETED':
			return transition(current, current.phase, 'read completed', {
				currentTarget: event.target?.trim() || current.currentTarget,
			})

		case 'GRAPH_HINTS_UPDATED':
			return transition(current, current.phase, 'graph hints updated', {
				currentTarget: event.currentTarget?.trim() || current.currentTarget,
			})

		case 'CONTEXT_READY':
			return transition(current, 'compile_prompt', 'context ready', {
				currentTarget: event.currentTarget?.trim() || current.currentTarget,
			})

		case 'PROMPT_COMPILED':
			return transition(current, 'plan', 'prompt compiled', {
				compiledPrompt: event.compiledPrompt,
			})

		case 'PLAN_READY': {
			const workPacket = event.workPacket ?? buildWorkflowWorkPacket(event.plan)
			const nextPhase: WorkflowPhase = current.workflowMode === 'strict' ? 'edit' : 'plan'
			return transition(current, nextPhase, 'plan ready', {
				mode: event.plan.mode,
				selectedTaskIds: workPacket.selectedTaskIds,
				currentTarget: workPacket.currentTarget || current.currentTarget,
				validationCommands: workPacket.validationCommands,
				workPacket,
				executionPlan: event.plan,
				specSyncStatus: event.plan.mode === 'spec-driven' ? 'locked' : 'n/a',
				verificationStatus: '',
				completedValidationCommands: [],
				validationResults: {},
			})
		}

		case 'EDIT_APPLIED':
			return transition(current, 'run', event.noOp ? 'no-op recorded' : 'edit applied', {
				currentTarget: event.currentTarget?.trim() || current.currentTarget,
			})

		case 'RUN_COMPLETED':
			return transition(current, 'verify', `run completed (${event.command})`)

		case 'VERIFY_COMPLETED': {
			const results = { ...current.validationResults, [event.command]: event.status }
			const completedValidationCommands = Array.from(
				new Set([...current.completedValidationCommands, event.command]),
			)
			const verificationStatus = summarizeVerificationStatus(current.validationCommands, results, event.status)
			const base = normalizeWorkflowState(
				{
					...current,
					completedValidationCommands,
					validationResults: results,
					verificationStatus,
				},
				current.workflowMode,
			)
			if (verificationStatus === 'fail' || verificationStatus === 'flaky' || verificationStatus === 'unknown') {
				return transition(base, 'backprop', `verify -> ${verificationStatus}`, {
					specSyncStatus: current.mode === 'spec-driven' ? 'backprop-required' : 'n/a',
				})
			}
			if (getRemainingValidationCommands(base).length === 0 && verificationStatus === 'pass') {
				return transition(base, 'done', 'verify -> pass', {
					specSyncStatus: current.mode === 'spec-driven' ? 'synced' : 'n/a',
				})
			}
			return transition(base, 'verify', `verify pending (${event.command})`)
		}

		case 'BACKPROP_COMPLETED': {
			const outcome = event.outcome ?? 'blocked'
			if (outcome === 'edit') {
				return transition(current, 'edit', 'backprop -> edit', {
					specSyncStatus: current.mode === 'spec-driven' ? 'backprop-complete' : 'n/a',
					verificationStatus: '',
				})
			}
			if (outcome === 'done') {
				return transition(current, 'done', 'backprop -> done', {
					specSyncStatus: current.mode === 'spec-driven' ? 'backprop-complete' : 'n/a',
				})
			}
			return transition(current, 'blocked', 'backprop -> blocked', {
				blockedReason:
					event.message?.trim() ||
					'Verification failed and was backpropped; explicit retry or new goal required.',
				specSyncStatus: current.mode === 'spec-driven' ? 'backprop-complete' : 'n/a',
			})
		}

		case 'DELEGATE_STARTED':
			return transition(current, delegatePhaseForKind(event.kind), `delegate started (${event.jobId})`, {
				delegateChildren: Array.from(new Set([...current.delegateChildren, event.jobId])),
				delegateParentPhase: event.parentPhase ?? current.phase,
			})

		case 'DELEGATE_FINISHED':
		case 'DELEGATE_COMPLETED': {
			if (event.result === 'block' || event.status === 'failed') {
				return transition(current, 'blocked', `delegate ${event.status} (${event.jobId})`, {
					blockedReason: `Delegate ${event.jobId} ${event.status}.`,
				})
			}
			return transition(
				current,
				(event.resumePhase ?? current.delegateParentPhase) || 'edit',
				`delegate ${event.status} (${event.jobId})`,
				{
					delegateParentPhase: '',
				},
			)
		}

		case 'RECOVERY_REQUIRED':
			return transition(current, 'recovery', 'recovery required', {
				recoverySourcePhase: event.sourcePhase ?? current.phase,
				recoveryState: `from=${event.sourcePhase ?? current.phase}; class=${event.classification ?? 'unknown'}`,
			})

		case 'RECOVERY_COMPLETED':
			if (event.success) {
				return transition(
					current,
					(event.restorePhase ?? current.recoverySourcePhase) || 'load_context',
					'recovery restored',
					{
						recoveryState: `restored=${(event.restorePhase ?? current.recoverySourcePhase) || 'load_context'}`,
						recoverySourcePhase: '',
						blockedReason: '',
					},
				)
			}
			return transition(current, 'blocked', 'recovery blocked', {
				blockedReason: event.message?.trim() || 'Recovery failed; manual intervention required.',
				recoveryState: `failed=${current.recoverySourcePhase || current.phase}`,
			})

		case 'WORKFLOW_CANCELLED':
			return transition(current, 'cancelled', 'workflow cancelled', {
				blockedReason: event.reason?.trim() || '',
			})
	}
}

function transition(
	current: WorkflowState,
	phase: WorkflowPhase,
	message: string,
	overrides: Partial<WorkflowState> = {},
): WorkflowState {
	const next = normalizeWorkflowState(
		{
			...current,
			...overrides,
			phase,
			allowedTools: getAllowedToolsForPhase(phase),
			nextRequiredAction:
				overrides.nextRequiredAction ??
				describePhaseAction(phase, overrides.validationCommands ?? current.validationCommands),
			lastTransition: `${current.phase} -> ${phase} (${message})`,
			lastEvent: message,
		},
		current.workflowMode,
	)
	return next
}

function summarizeVerificationStatus(
	validationCommands: string[],
	results: Record<string, VerificationStatus>,
	lastStatus: VerificationStatus,
): VerificationStatus {
	const recorded = Object.values(results)
	if (recorded.includes('fail')) return 'fail'
	if (recorded.includes('flaky')) return 'flaky'
	if (recorded.includes('unknown')) return 'unknown'
	if (validationCommands.length === 0) return lastStatus
	const allCommandsPassed = validationCommands.every(command => results[command] === 'pass')
	return allCommandsPassed ? 'pass' : lastStatus
}

function delegatePhaseForKind(kind: 'index' | 'review' | 'research' | 'custom'): WorkflowPhase {
	if (kind === 'index') return 'delegate_index'
	if (kind === 'review') return 'delegate_review'
	return 'delegate_research'
}

function describePhaseAction(phase: WorkflowPhase, validationCommands: string[]): string {
	if (phase === 'run' && validationCommands.length > 0) {
		return `Run locked validation: ${validationCommands.join(' ; ')}`
	}
	if (phase === 'backprop') {
		return 'Backprop the failing verification before retrying or closing.'
	}
	if (phase === 'delegate_research' || phase === 'delegate_review' || phase === 'delegate_index') {
		return 'Wait for the delegate result or continue/cancel the delegate.'
	}
	if (phase === 'blocked') {
		return 'Resolve the blocked state or restart with a new goal.'
	}
	return normalizeWorkflowState({ sessionID: 'tmp', phase, validationCommands }, 'advisory').nextRequiredAction
}
