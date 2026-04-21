import type { ExtraContext } from '../context/instructions.js'
import type { MemoryHeader } from '../memory/scan.js'
import type { TaskFocusState } from '../context/compaction.js'
import type { CompiledPrompt, ExecutionPlan, ExecutionStep } from './types.js'

interface CaveKitTask {
	id: string
	status: string
	task: string
	cites: string[]
}

export function buildExecutionPlan(input: {
	compiledPrompt: CompiledPrompt
	rootContext: ExtraContext[]
	memories: MemoryHeader[]
	taskFocus: TaskFocusState
}): ExecutionPlan {
	const spec = input.rootContext.find(ctx => ctx.label === 'CaveKit Spec')
	const tasks = spec ? parseCaveKitTasks(spec.content) : []
	const mode = tasks.length > 0 ? 'spec-driven' : 'ad-hoc'
	const validationCommands = inferValidationCommands(input.compiledPrompt, input.memories)
	const sourceArtifacts = input.rootContext.map(ctx => ctx.label)
	const memoryRefs = input.memories.map(memory => memory.title)

	if (mode === 'spec-driven') {
		const selectedTasks = selectTasks(tasks, input.compiledPrompt)
		return {
			mode,
			goal: spec?.content
				? extractSpecGoal(spec.content) || input.compiledPrompt.goal
				: input.compiledPrompt.goal,
			summary: buildSpecSummary(selectedTasks, validationCommands),
			steps: selectedTasks.map((task, index) => ({
				id: task.id || `S${index + 1}`,
				kind: index === selectedTasks.length - 1 ? 'verify' : 'edit',
				title: task.task,
				reason: task.status === '~' ? 'Resume active CaveKit task.' : 'Advance next CaveKit task from SPEC.md.',
				citations: task.cites,
				acceptance: buildAcceptance(task, validationCommands),
			})),
			sourceArtifacts,
			specSource: spec?.source ?? '',
			memoryRefs,
			validationCommands,
		}
	}

	const adHocSteps = buildAdHocSteps(input.compiledPrompt, input.taskFocus, validationCommands)
	return {
		mode,
		goal: input.compiledPrompt.goal,
		summary: `Ad-hoc runtime plan. Inspect likely files, apply smallest correct edit, then verify with ${formatValidationList(validationCommands)}.`,
		steps: adHocSteps,
		sourceArtifacts,
		specSource: '',
		memoryRefs,
		validationCommands,
	}
}

export function renderExecutionPlan(plan: ExecutionPlan, phase: string): string {
	const lines: string[] = [
		`# Hybrid Runtime Plan (${plan.mode})`,
		'',
		`Phase: ${phase}`,
		`Goal: ${plan.goal}`,
		`Summary: ${plan.summary}`,
	]

	if (plan.sourceArtifacts.length > 0) {
		lines.push(`Sources: ${plan.sourceArtifacts.join(', ')}`)
	}

	if (plan.memoryRefs.length > 0) {
		lines.push(`Memory: ${plan.memoryRefs.join(', ')}`)
	}

	if (plan.validationCommands.length > 0) {
		lines.push(`Verify: ${plan.validationCommands.join(' ; ')}`)
	}

	if (plan.steps.length > 0) {
		lines.push('', '## Steps')
		for (const step of plan.steps.slice(0, 5)) {
			lines.push(`- ${step.id} [${step.kind}] ${step.title}`)
			if (step.citations.length > 0) lines.push(`  cites: ${step.citations.join(', ')}`)
			if (step.acceptance.length > 0) lines.push(`  accept: ${step.acceptance.join(' | ')}`)
		}
	}

	return lines.join('\n')
}

export function summarizeExecutionPlan(plan: ExecutionPlan): string {
	const steps = plan.steps
		.slice(0, 3)
		.map(step => `${step.id}:${step.title}`)
		.join(' | ')
	return `${plan.mode}; ${plan.goal}; ${steps}`.trim()
}

function parseCaveKitTasks(content: string): CaveKitTask[] {
	const match = content.match(/##\s+§T\s+TASKS\n([\s\S]*?)(?:\n##\s+§|$)/i)
	if (!match?.[1]) return []

	const rows = match[1]
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('id|status|task|cites'))

	const tasks: CaveKitTask[] = []
	for (const row of rows) {
		const cells = row.split('|').map(cell => cell.trim())
		if (cells.length < 4) continue
		tasks.push({
			id: cells[0] ?? '',
			status: cells[1] ?? '.',
			task: cells[2] ?? '',
			cites: (cells[3] ?? '-')
				.split(',')
				.map(value => value.trim())
				.filter(value => value && value !== '-'),
		})
	}
	return tasks
}

function selectTasks(tasks: CaveKitTask[], prompt: CompiledPrompt): CaveKitTask[] {
	const openTasks = tasks.filter(task => task.status !== 'x')
	const matched = openTasks.filter(task => prompt.keywords.some(keyword => task.task.toLowerCase().includes(keyword)))
	const selected = matched.length > 0 ? matched : openTasks
	return selected.slice(0, 3)
}

function buildAcceptance(task: CaveKitTask, validationCommands: string[]): string[] {
	const acceptance = ['Edit complete and behavior aligned with cited spec references.']
	if (task.cites.length > 0) acceptance.push(`Respect ${task.cites.join(', ')}.`)
	if (validationCommands.length > 0) acceptance.push(`Run ${formatValidationList(validationCommands)}.`)
	return acceptance
}

function buildSpecSummary(tasks: CaveKitTask[], validationCommands: string[]): string {
	const taskSummary = tasks.map(task => `${task.id}:${task.task}`).join(' | ')
	const verification =
		validationCommands.length > 0 ? ` Verify with ${formatValidationList(validationCommands)}.` : ''
	return `SPEC-backed plan. Advance ${taskSummary}.${verification}`.trim()
}

function buildAdHocSteps(
	compiledPrompt: CompiledPrompt,
	taskFocus: TaskFocusState,
	validationCommands: string[],
): ExecutionStep[] {
	const inspectTitle = taskFocus.activeArtifacts[0]
		? `Inspect related files starting from ${taskFocus.activeArtifacts[0]}`
		: 'Inspect relevant files and current behavior'
	return [
		{
			id: 'A1',
			kind: 'inspect',
			title: inspectTitle,
			reason: 'Need file-level context before editing.',
			citations: [],
			acceptance: ['Relevant code path identified.'],
		},
		{
			id: 'A2',
			kind: 'edit',
			title: compiledPrompt.goal,
			reason: 'Implement smallest correct change for current request.',
			citations: compiledPrompt.constraints.map(constraint => constraint.text),
			acceptance: ['Requested behavior implemented.', 'Constraints preserved.'],
		},
		{
			id: 'A3',
			kind: 'verify',
			title: `Verify with ${formatValidationList(validationCommands)}`,
			reason: 'Need concrete signal before marking work complete.',
			citations: [],
			acceptance: validationCommands.map(command => `Run ${command}`),
		},
	]
}

function inferValidationCommands(compiledPrompt: CompiledPrompt, memories: MemoryHeader[]): string[] {
	const text = `${compiledPrompt.normalized} ${memories.map(memory => memory.title).join(' ')}`.toLowerCase()
	if (/\btest\b|spec\b|jest\b|vitest\b/.test(text)) return ['bun test']
	if (/\blint\b/.test(text)) return ['bun run lint']
	if (/\btypecheck\b|typescript\b/.test(text)) return ['bun run typecheck']
	if (/\bbuild\b/.test(text)) return ['bun run build']
	return ['bun test', 'bun run typecheck']
}

function extractSpecGoal(content: string): string {
	const match = content.match(/##\s+§G\s+GOAL\n([^\n]+)/i)
	return match?.[1]?.trim() ?? ''
}

function formatValidationList(commands: string[]): string {
	return commands.join(' + ')
}
