import { createHash } from 'node:crypto'
import type { VerificationStatus } from './types.js'
import { reduceWorkflow } from './workflow-reducer.js'
import { WorkflowStore } from './workflow-store.js'
import {
	createWorkflowState,
	getWorkflowExitCondition,
	getWorkflowPhaseLabel,
	matchesAllowedWorkflowTool,
	normalizeWorkflowState,
	resolveLockedValidationCommand,
	toWorkflowStatusSnapshot,
	type WorkflowEvent,
	type WorkflowRuntimeMode,
	type WorkflowStatusSnapshot,
	type WorkflowToolGateResult,
} from './workflow-types.js'

export class WorkflowEngine {
	private readonly store: WorkflowStore

	constructor(options: { dataDir: string; workflowMode?: WorkflowRuntimeMode }) {
		this.workflowMode = options.workflowMode ?? 'advisory'
		this.store = new WorkflowStore(options.dataDir, this.workflowMode)
	}

	readonly workflowMode: WorkflowRuntimeMode

	getState(sessionID: string) {
		return this.store.get(sessionID) ?? createWorkflowState(sessionID, this.workflowMode)
	}

	getSnapshot(sessionID: string): WorkflowStatusSnapshot | null {
		const state = this.store.get(sessionID)
		return state ? toWorkflowStatusSnapshot(state) : null
	}

	dispatch(sessionID: string, event: WorkflowEvent): WorkflowStatusSnapshot {
		const current = this.getState(sessionID)
		const next = reduceWorkflow(normalizeWorkflowState(current, this.workflowMode), event)
		return toWorkflowStatusSnapshot(this.store.set(next))
	}

	clear(sessionID: string): void {
		this.store.delete(sessionID)
	}

	createGoalHash(input: string): string {
		return createHash('sha1').update(input.trim()).digest('hex')
	}

	gateTool(sessionID: string, toolName: string, args: Record<string, unknown> = {}): WorkflowToolGateResult {
		const snapshot =
			this.getSnapshot(sessionID) ?? toWorkflowStatusSnapshot(createWorkflowState(sessionID, this.workflowMode))
		if (this.workflowMode !== 'strict') {
			return {
				allowed: true,
				phase: snapshot.phase,
				allowedTools: snapshot.allowedTools,
				nextRequiredAction: snapshot.nextRequiredAction,
				exitCondition: snapshot.exitCondition,
				reason: '',
			}
		}

		if (!matchesAllowedWorkflowTool(toolName, snapshot.allowedTools)) {
			return blocked(snapshot, `Tool '${toolName}' is not allowed during phase '${snapshot.phase}'.`)
		}

		if (toolName === 'bash') {
			const command = typeof args.command === 'string' ? args.command : ''
			const locked = resolveLockedValidationCommand(command, snapshot.validationCommands)
			if ((snapshot.phase === 'run' || snapshot.phase === 'verify') && locked) {
				return allowed(snapshot)
			}
			return blocked(
				snapshot,
				snapshot.validationCommands.length > 0
					? `Only locked validation commands are allowed: ${snapshot.validationCommands.join(' ; ')}`
					: 'No locked validation commands are available in the current workflow.',
			)
		}

		if (toolName === 'openharness_delegate_start' && snapshot.phase !== 'edit') {
			return blocked(snapshot, 'Delegate start is only allowed from the edit phase.')
		}

		if (
			(toolName === 'openharness_delegate_continue' || toolName === 'openharness_delegate_cancel') &&
			!snapshot.phase.startsWith('delegate_')
		) {
			return blocked(snapshot, `Delegate follow-up is only allowed while a delegate phase is active.`)
		}

		if (toolName === 'openharness_cavekit_backprop' && snapshot.phase !== 'backprop') {
			return blocked(snapshot, 'Backprop is only allowed from the backprop phase.')
		}

		if (toolName === 'openharness_cavekit_spec' && snapshot.phase !== 'backprop') {
			return blocked(snapshot, 'SPEC mutation is only allowed during backprop in strict mode.')
		}

		return allowed(snapshot)
	}

	renderPhaseContract(sessionID: string): string {
		const snapshot = this.getSnapshot(sessionID)
		if (!snapshot) return ''
		const lines: string[] = ['# Workflow Phase Contract', '']
		lines.push(`Workflow mode: ${snapshot.workflowMode}`)
		lines.push(`Phase: ${getWorkflowPhaseLabel(snapshot.phase)}`)
		lines.push(`Allowed tools: ${snapshot.allowedTools.join(', ') || 'none'}`)
		lines.push(`Exit condition: ${snapshot.exitCondition}`)
		lines.push(`Next required action: ${snapshot.nextRequiredAction}`)
		if (snapshot.blockedReason) lines.push(`Blocked reason: ${snapshot.blockedReason}`)
		if (snapshot.lastTransition) lines.push(`Last transition: ${snapshot.lastTransition}`)
		if (snapshot.selectedTaskIds.length > 0) lines.push(`Selected tasks: ${snapshot.selectedTaskIds.join(', ')}`)
		if (snapshot.specSyncStatus) lines.push(`Spec sync: ${snapshot.specSyncStatus}`)
		if (snapshot.verifyContract.length > 0) lines.push(`Verify contract: ${snapshot.verifyContract.join(' ; ')}`)
		if (snapshot.delegateChildren.length > 0)
			lines.push(`Delegate children: ${snapshot.delegateChildren.join(', ')}`)
		if (snapshot.recoveryState) lines.push(`Recovery state: ${snapshot.recoveryState}`)
		if (snapshot.workPacket) {
			lines.push('', '## Current work packet')
			lines.push(`Goal: ${snapshot.workPacket.goal}`)
			lines.push(`Mode: ${snapshot.workPacket.mode}`)
			lines.push(`Current target: ${snapshot.workPacket.currentTarget || 'n/a'}`)
			if (snapshot.workPacket.sourceArtifacts.length > 0) {
				lines.push(`Source artifacts: ${snapshot.workPacket.sourceArtifacts.join(', ')}`)
			}
			if (snapshot.workPacket.acceptanceCriteria.length > 0) {
				lines.push('Acceptance criteria:')
				for (const criterion of snapshot.workPacket.acceptanceCriteria.slice(0, 8)) lines.push(`- ${criterion}`)
			}
		}
		return lines.join('\n')
	}

	resolveValidationCommand(sessionID: string, command: string): string {
		const snapshot = this.getSnapshot(sessionID)
		if (!snapshot) return ''
		return resolveLockedValidationCommand(command, snapshot.validationCommands)
	}
}

function allowed(snapshot: WorkflowStatusSnapshot): WorkflowToolGateResult {
	return {
		allowed: true,
		phase: snapshot.phase,
		allowedTools: snapshot.allowedTools,
		nextRequiredAction: snapshot.nextRequiredAction,
		exitCondition: getWorkflowExitCondition(snapshot),
		reason: '',
	}
}

function blocked(snapshot: WorkflowStatusSnapshot, reason: string): WorkflowToolGateResult {
	return {
		allowed: false,
		phase: snapshot.phase,
		allowedTools: snapshot.allowedTools,
		nextRequiredAction: snapshot.nextRequiredAction,
		exitCondition: getWorkflowExitCondition(snapshot),
		reason,
	}
}

export function formatWorkflowGateMessage(result: WorkflowToolGateResult, toolName: string): string {
	return [
		`Workflow blocked tool '${toolName}'.`,
		`Phase: ${result.phase}`,
		`Reason: ${result.reason}`,
		`Allowed tools: ${result.allowedTools.join(', ') || 'none'}`,
		`Next required action: ${result.nextRequiredAction}`,
		`Exit condition: ${result.exitCondition}`,
	].join('\n')
}

export function isWorkflowMutationTool(toolName: string): boolean {
	return (
		toolName === 'write' ||
		toolName === 'edit' ||
		toolName === 'openharness_patch' ||
		toolName === 'openharness_caveman_compress_file'
	)
}

export function shouldDispatchVerification(status: VerificationStatus): boolean {
	return status === 'pass' || status === 'fail' || status === 'flaky' || status === 'unknown'
}
