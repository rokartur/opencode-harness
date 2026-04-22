import { join } from 'node:path'
import { ensureDir, readFileText, withFileLock, writeFileAtomic } from '../shared/fs.js'
import { normalizeWorkflowState, type WorkflowRuntimeMode, type WorkflowState } from './workflow-types.js'

const WORKFLOW_STORE_FILE = 'workflow-state.json'
const WORKFLOW_STORE_LOCK = 'workflow-state.lock'

export class WorkflowStore {
	private readonly filePath: string
	private readonly lockPath: string
	private readonly states = new Map<string, WorkflowState>()

	constructor(
		private readonly dataDir: string,
		private readonly workflowMode: WorkflowRuntimeMode,
	) {
		this.filePath = join(dataDir, WORKFLOW_STORE_FILE)
		this.lockPath = join(dataDir, WORKFLOW_STORE_LOCK)
		this.load()
	}

	get(sessionID: string): WorkflowState | null {
		const state = this.states.get(sessionID)
		return state ? normalizeWorkflowState(state, this.workflowMode) : null
	}

	set(state: WorkflowState): WorkflowState {
		const normalized = normalizeWorkflowState(state, this.workflowMode)
		this.states.set(normalized.sessionID, normalized)
		this.persist()
		return normalized
	}

	delete(sessionID: string): void {
		if (!this.states.delete(sessionID)) return
		this.persist()
	}

	list(): WorkflowState[] {
		return Array.from(this.states.values()).map(state => normalizeWorkflowState(state, this.workflowMode))
	}

	private load(): void {
		const raw = readFileText(this.filePath)
		if (!raw) return
		try {
			const parsed = JSON.parse(raw) as { states?: Array<[string, WorkflowState]> }
			if (!Array.isArray(parsed.states)) return
			for (const [sessionID, state] of parsed.states) {
				if (typeof sessionID !== 'string' || !state) continue
				this.states.set(sessionID, normalizeWorkflowState({ ...state, sessionID }, this.workflowMode))
			}
		} catch {
			// ignore malformed persisted state
		}
	}

	private persist(): void {
		ensureDir(this.dataDir)
		withFileLock(this.lockPath, () => {
			writeFileAtomic(
				this.filePath,
				JSON.stringify(
					{
						version: 1,
						states: Array.from(this.states.entries()),
					},
					null,
					2,
				),
			)
		})
	}
}
