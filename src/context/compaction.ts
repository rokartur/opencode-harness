import { findRelevantMemories } from '../memory/search.js'
import type { MemoryHeader } from '../memory/scan.js'
import type { LoadedCompatPlugin } from '../shared/types.js'

export interface TaskFocusState {
	goal: string
	recentGoals: string[]
	activeArtifacts: string[]
	verifiedState: string[]
	nextStep: string
}

export interface CompactionContext {
	taskFocus: TaskFocusState | null
	recentWorkLog: string[]
	recentVerifiedWork: string[]
	invokedSkills: string[]
	relevantMemories: MemoryHeader[]
	activePlugins: Array<{ name: string; version: string }>
}

export function buildCompactionContext(opts: {
	cwd: string
	lastPrompt: string
	plugins: LoadedCompatPlugin[]
	invokedSkills: string[]
	sessionState: SessionStateTracker
}): CompactionContext {
	const { cwd, lastPrompt, plugins, invokedSkills, sessionState } = opts

	const memories = lastPrompt ? findRelevantMemories(lastPrompt, cwd, 3) : []

	return {
		taskFocus: sessionState.getTaskFocus(),
		recentWorkLog: sessionState.getRecentWorkLog(),
		recentVerifiedWork: sessionState.getRecentVerifiedWork(),
		invokedSkills,
		relevantMemories: memories,
		activePlugins: plugins
			.filter(p => p.enabled)
			.map(p => ({ name: p.manifest.name, version: p.manifest.version })),
	}
}

export function formatCompactionAttachments(ctx: CompactionContext): string {
	const parts: string[] = []

	if (ctx.taskFocus && (ctx.taskFocus.goal || ctx.taskFocus.nextStep)) {
		const lines: string[] = ['[Compact attachment: task focus]']
		if (ctx.taskFocus.goal) lines.push(`Goal: ${ctx.taskFocus.goal}`)
		if (ctx.taskFocus.nextStep) lines.push(`Next step: ${ctx.taskFocus.nextStep}`)
		if (ctx.taskFocus.activeArtifacts.length > 0) {
			lines.push(`Active artifacts: ${ctx.taskFocus.activeArtifacts.join(', ')}`)
		}
		if (ctx.taskFocus.verifiedState.length > 0) {
			lines.push(`Verified: ${ctx.taskFocus.verifiedState.slice(-5).join('; ')}`)
		}
		parts.push(lines.join('\n'))
	}

	if (ctx.recentWorkLog.length > 0) {
		const lines = ['[Compact attachment: recent work log]']
		lines.push(...ctx.recentWorkLog.slice(-8))
		parts.push(lines.join('\n'))
	}

	if (ctx.relevantMemories.length > 0) {
		const lines = ['[Compact attachment: relevant memories]']
		for (const m of ctx.relevantMemories) {
			lines.push(`- ${m.title}: ${m.description.slice(0, 120)}`)
		}
		parts.push(lines.join('\n'))
	}

	if (ctx.invokedSkills.length > 0) {
		parts.push(`[Compact attachment: invoked skills]\nSkills used: ${ctx.invokedSkills.join(', ')}`)
	}

	if (ctx.activePlugins.length > 0) {
		const pluginList = ctx.activePlugins.map(p => `${p.name}@${p.version}`).join(', ')
		parts.push(`[Compact attachment: active plugins]\n${pluginList}`)
	}

	return parts.join('\n\n')
}

const MAX_CHARS = 4000

export function truncateCompactionContext(formatted: string): string {
	if (formatted.length <= MAX_CHARS) return formatted
	return formatted.slice(0, MAX_CHARS) + '\n[...truncated]'
}

export class SessionStateTracker {
	private goal = ''
	private recentGoals: string[] = []
	private activeArtifacts: string[] = []
	private verifiedState: string[] = []
	private nextStep = ''
	private workLog: string[] = []
	private maxEntries: number

	constructor(maxEntries: number = 10) {
		this.maxEntries = maxEntries
	}

	updateGoal(goal: string): void {
		if (goal && goal !== this.goal) {
			if (this.goal) {
				this.recentGoals.push(this.goal)
				if (this.recentGoals.length > 5) this.recentGoals.shift()
			}
			this.goal = goal
		}
	}

	addArtifact(artifact: string): void {
		if (!artifact) return
		const idx = this.activeArtifacts.indexOf(artifact)
		if (idx !== -1) this.activeArtifacts.splice(idx, 1)
		this.activeArtifacts.push(artifact)
		if (this.activeArtifacts.length > 8) this.activeArtifacts.shift()
	}

	addVerifiedState(state: string): void {
		if (!state) return
		this.verifiedState.push(state)
		if (this.verifiedState.length > 10) this.verifiedState.shift()
	}

	setNextStep(step: string): void {
		this.nextStep = step
	}

	addWorkLogEntry(entry: string): void {
		if (!entry) return
		this.workLog.push(entry)
		if (this.workLog.length > this.maxEntries) this.workLog.shift()
	}

	getTaskFocus(): TaskFocusState {
		return {
			goal: this.goal,
			recentGoals: [...this.recentGoals],
			activeArtifacts: [...this.activeArtifacts],
			verifiedState: [...this.verifiedState],
			nextStep: this.nextStep,
		}
	}

	getRecentWorkLog(): string[] {
		return [...this.workLog]
	}

	getRecentVerifiedWork(): string[] {
		return [...this.verifiedState]
	}

	reset(): void {
		this.goal = ''
		this.recentGoals = []
		this.activeArtifacts = []
		this.verifiedState = []
		this.nextStep = ''
		this.workLog = []
	}
}
