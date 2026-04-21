import { readFileText, writeFileAtomic, fileExists } from '../shared/fs.js'
import type { ExecutionPlan, VerificationRecord } from './types.js'

export function applyVerificationToSpec(plan: ExecutionPlan | null, verification: VerificationRecord): boolean {
	if (!plan || plan.mode !== 'spec-driven' || !plan.specSource || !fileExists(plan.specSource)) return false

	const current = readFileText(plan.specSource)
	if (!current) return false

	let next = current
	next = updateTaskStatuses(next, plan, verification)
	if (verification.status === 'fail' || verification.status === 'flaky' || verification.status === 'unknown') {
		next = appendBugRow(next, plan, verification)
		next = appendInvariant(next, plan, verification)
	}

	if (next === current) return false
	writeFileAtomic(plan.specSource, ensureTrailingNewline(next))
	return true
}

function updateTaskStatuses(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const taskIDs = new Set(plan.steps.map(step => step.id).filter(id => /^T\d+$/.test(id)))
	if (taskIDs.size === 0) return spec
	const taskSection = spec.match(/(##\s+§T\s+TASKS\n)([\s\S]*?)(?=\n##\s+§|$)/i)
	if (!taskSection) return spec
	const header = taskSection[1] ?? ''
	const body = taskSection[2] ?? ''
	const lines = body.split('\n')
	const targetStatus = verification.status === 'pass' ? 'x' : '~'
	let changed = false
	const updated = lines.map(line => {
		if (!/^T\d+\|/.test(line)) return line
		const cells = line.split('|')
		if (cells.length < 4) return line
		if (!taskIDs.has(cells[0] ?? '')) return line
		if (cells[1] === 'x' && targetStatus === '~') return line
		if ((cells[1] === '.' || cells[1] === '~') && targetStatus === 'x') {
			cells[1] = 'x'
			changed = true
			return cells.join('|')
		}
		if (cells[1] === '.' && targetStatus === '~') {
			cells[1] = '~'
			changed = true
			return cells.join('|')
		}
		return line
	})
	if (!changed) return spec
	return spec.replace(taskSection[0], `${header}${updated.join('\n')}`)
}

function appendBugRow(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const bugSection = spec.match(/(##\s+§B\s+BUGS\n)([\s\S]*?)(?=\n##\s+§|$)/i)
	if (!bugSection) return spec
	const header = bugSection[1] ?? ''
	const body = bugSection[2] ?? ''
	const lines = body.trimEnd().split('\n').filter(Boolean)
	const nextId = `B${countRows(lines, /^B\d+\|/) + 1}`
	const date = new Date(verification.timestamp).toISOString().slice(0, 10)
	const cause = truncateCell(`${verification.command} -> ${verification.status}`, 80)
	const fix = truncateCell(inferFixReference(plan, verification), 80)
	const row = `${nextId}|${date}|${cause}|${fix}`
	if (lines.includes(row)) return spec
	const updated = lines.length > 0 ? [...lines, row] : ['id|date|cause|fix', row]
	return spec.replace(bugSection[0], `${header}${updated.join('\n')}\n`)
}

function appendInvariant(spec: string, plan: ExecutionPlan, verification: VerificationRecord): string {
	const invariantSection = spec.match(/(##\s+§V\s+INVARIANTS\n)([\s\S]*?)(?=\n##\s+§|$)/i)
	if (!invariantSection) return spec
	const header = invariantSection[1] ?? ''
	const body = invariantSection[2] ?? ''
	const lines = body.trimEnd().split('\n').filter(Boolean)
	const invariant = inferInvariantLine(lines, plan, verification)
	if (!invariant) return spec
	if (lines.some(line => line.toLowerCase() === invariant.toLowerCase())) return spec
	const updated = [...lines, invariant]
	return spec.replace(invariantSection[0], `${header}${updated.join('\n')}\n`)
}

function inferFixReference(plan: ExecutionPlan, verification: VerificationRecord): string {
	const citations = plan.steps.flatMap(step => step.citations)
	if (citations.length > 0) return citations.join(',')
	return verification.status === 'fail' ? 'new invariant' : 'investigate'
}

function inferInvariantLine(existing: string[], plan: ExecutionPlan, verification: VerificationRecord): string {
	const nextNumber = countRows(existing, /^V\d+:/i) + 1
	const cite = plan.steps.flatMap(step => step.citations).find(Boolean)
	const suffix = cite ? ` Preserve ${cite}.` : ''
	return `V${nextNumber}: verify ${verification.command} ! regress.${suffix}`
}

function countRows(lines: string[], pattern: RegExp): number {
	return lines.filter(line => pattern.test(line)).length
}

function truncateCell(value: string, max: number): string {
	const safe = value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
	return safe.length <= max ? safe : `${safe.slice(0, max - 3)}...`
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith('\n') ? value : `${value}\n`
}
