import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { ensureDir, readFileText, writeFileAtomic } from '../shared/fs.js'

export type DelegateJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type DelegateJobMode = 'shell' | 'session'

export interface DelegateSessionDispatchResult {
	taskID?: string
	status?: 'running' | 'done'
	output?: string
}

export interface DelegateSessionInspection {
	status?: DelegateJobStatus
	output?: string
	error?: string
}

export interface DelegateSessionAdapter {
	createSession(input: { label: string; cwd: string; parentSessionID?: string }): Promise<{ sessionID: string }>
	promptSession(input: {
		sessionID: string
		agent: string
		prompt: string
		model?: string
		cwd: string
	}): Promise<DelegateSessionDispatchResult>
	continueSession?(input: {
		sessionID: string
		agent: string
		prompt: string
		model?: string
		cwd: string
	}): Promise<DelegateSessionDispatchResult>
	inspectSession?(input: { sessionID: string; cwd: string }): Promise<DelegateSessionInspection | null>
	abortSession?(input: { sessionID: string; cwd: string }): Promise<void>
}

export interface DelegateJob {
	id: string
	label: string
	kind: string
	mode: DelegateJobMode
	command: string
	status: DelegateJobStatus
	startedAt: number | null
	completedAt: number | null
	exitCode: number | null
	output: string
	error: string
	cwd: string
	sessionID?: string
	taskID?: string
	agent?: string
	model?: string
	parentSessionID?: string
}

export interface DelegateAuditEntry {
	jobId: string
	label: string
	kind: string
	mode: DelegateJobMode
	status: DelegateJobStatus
	cwd: string
	startedAt: number | null
	completedAt: number | null
	sessionID?: string
}

export interface DelegateOptions {
	enabled: boolean
	maxConcurrent: number
	maxQueueSize: number
	dataDir: string
	cwd: string
	sessionAdapter: DelegateSessionAdapter | null
}

const DEFAULT_OPTIONS: DelegateOptions = {
	enabled: false,
	maxConcurrent: 2,
	maxQueueSize: 20,
	dataDir: '',
	cwd: '',
	sessionAdapter: null,
}

export class DelegateService {
	private readonly options: DelegateOptions
	private readonly jobs = new Map<string, DelegateJob>()
	private readonly childProcesses = new Map<string, ChildProcess>()
	private nextId = 1

	constructor(options: Partial<DelegateOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options }
		if (this.options.dataDir) {
			this.loadFromDisk()
		}
	}

	start(label: string, kind: string, command: string, cwd: string = this.options.cwd): DelegateJob {
		if (!this.options.enabled) {
			return this.createRejected(label, kind, 'shell', command, cwd, 'delegate disabled')
		}
		const queued = this.countByStatus('pending') + this.countByStatus('running')
		if (queued >= this.options.maxQueueSize) {
			return this.createRejected(label, kind, 'shell', command, cwd, 'delegate queue full')
		}
		const id = `D${this.nextId++}`
		const job: DelegateJob = {
			id,
			label,
			kind,
			mode: 'shell',
			command,
			status: 'pending',
			startedAt: null,
			completedAt: null,
			exitCode: null,
			output: '',
			error: '',
			cwd: cwd || this.options.cwd,
		}
		this.jobs.set(id, job)
		this.persist()
		this.runJob(id)
		return cloneJob(job)
	}

	async startSession(input: {
		label: string
		kind: string
		agent: string
		prompt: string
		context?: string
		model?: string
		cwd?: string
		parentSessionID?: string
	}): Promise<DelegateJob> {
		const cwd = input.cwd || this.options.cwd
		if (!this.options.enabled) {
			return this.createRejected(input.label, input.kind, 'session', '', cwd, 'delegate disabled')
		}
		if (!this.options.sessionAdapter) {
			return this.createRejected(
				input.label,
				input.kind,
				'session',
				'',
				cwd,
				'child-session delegate unavailable',
			)
		}
		const queued = this.countByStatus('pending') + this.countByStatus('running')
		if (queued >= this.options.maxQueueSize) {
			return this.createRejected(input.label, input.kind, 'session', '', cwd, 'delegate queue full')
		}
		const id = `D${this.nextId++}`
		const job: DelegateJob = {
			id,
			label: input.label,
			kind: input.kind,
			mode: 'session',
			command: '',
			status: 'running',
			startedAt: Date.now(),
			completedAt: null,
			exitCode: null,
			output: '',
			error: '',
			cwd,
			agent: input.agent,
			model: input.model,
			parentSessionID: input.parentSessionID,
		}
		this.jobs.set(id, job)
		this.persist()
		try {
			const created = await this.options.sessionAdapter.createSession({
				label: input.label,
				cwd,
				parentSessionID: input.parentSessionID,
			})
			job.sessionID = created.sessionID
			const fullPrompt = input.context ? `${input.context}\n\n---\n\n${input.prompt}` : input.prompt
			const dispatched = await this.options.sessionAdapter.promptSession({
				sessionID: created.sessionID,
				agent: input.agent,
				prompt: fullPrompt,
				model: input.model,
				cwd,
			})
			job.taskID = dispatched.taskID
			job.output = truncateOutput(dispatched.output ?? '')
			if (dispatched.status === 'done') {
				job.status = 'done'
				job.completedAt = Date.now()
			}
			this.persist()
			return cloneJob(job)
		} catch (error) {
			job.status = 'failed'
			job.error = error instanceof Error ? error.message : String(error)
			job.completedAt = Date.now()
			this.persist()
			return cloneJob(job)
		}
	}

	getStatus(id: string): DelegateJob | null {
		const job = this.jobs.get(id)
		return job ? cloneJob(job) : null
	}

	async refresh(id: string): Promise<DelegateJob | null> {
		const job = this.jobs.get(id)
		if (!job) return null
		if (job.mode !== 'session' || !job.sessionID || !this.options.sessionAdapter?.inspectSession) {
			return cloneJob(job)
		}
		try {
			const inspection = await this.options.sessionAdapter.inspectSession({
				sessionID: job.sessionID,
				cwd: job.cwd,
			})
			if (!inspection) return cloneJob(job)
			if (inspection.status) job.status = inspection.status
			if (inspection.output) job.output = truncateOutput(inspection.output)
			if (inspection.error) job.error = truncateError(inspection.error)
			if ((job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && !job.completedAt) {
				job.completedAt = Date.now()
			}
			this.persist()
			return cloneJob(job)
		} catch (error) {
			job.error = error instanceof Error ? error.message : String(error)
			this.persist()
			return cloneJob(job)
		}
	}

	list(status?: DelegateJobStatus): DelegateJob[] {
		const all = Array.from(this.jobs.values())
		const filtered = status ? all.filter(job => job.status === status) : all
		return filtered.map(cloneJob)
	}

	async continue(id: string, prompt: string, context?: string): Promise<DelegateJob | null> {
		const job = this.jobs.get(id)
		if (!job || job.mode !== 'session' || !job.sessionID || !job.agent || !this.options.sessionAdapter) return null
		const send = this.options.sessionAdapter.continueSession ?? this.options.sessionAdapter.promptSession
		const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt
		try {
			const dispatched = await send({
				sessionID: job.sessionID,
				agent: job.agent,
				prompt: fullPrompt,
				model: job.model,
				cwd: job.cwd,
			})
			job.taskID = dispatched.taskID ?? job.taskID
			job.output = dispatched.output ? truncateOutput(dispatched.output) : job.output
			job.status = dispatched.status === 'done' ? 'done' : 'running'
			job.completedAt = job.status === 'done' ? Date.now() : null
			job.error = ''
			this.persist()
			return cloneJob(job)
		} catch (error) {
			job.status = 'failed'
			job.error = error instanceof Error ? error.message : String(error)
			job.completedAt = Date.now()
			this.persist()
			return cloneJob(job)
		}
	}

	async cancel(id: string): Promise<DelegateJob | null> {
		const job = this.jobs.get(id)
		if (!job) return null
		if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
			return cloneJob(job)
		}
		job.status = 'cancelled'
		job.completedAt = Date.now()
		if (job.mode === 'shell') {
			const child = this.childProcesses.get(id)
			if (child && !child.killed) child.kill('SIGTERM')
			this.childProcesses.delete(id)
		} else if (job.mode === 'session' && job.sessionID && this.options.sessionAdapter?.abortSession) {
			try {
				await this.options.sessionAdapter.abortSession({ sessionID: job.sessionID, cwd: job.cwd })
			} catch (error) {
				job.error = error instanceof Error ? error.message : String(error)
			}
		}
		this.persist()
		this.runNextPending()
		return cloneJob(job)
	}

	getAudit(): DelegateAuditEntry[] {
		return Array.from(this.jobs.values()).map(job => ({
			jobId: job.id,
			label: job.label,
			kind: job.kind,
			mode: job.mode,
			status: job.status,
			cwd: job.cwd,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			sessionID: job.sessionID,
		}))
	}

	renderAudit(): string {
		const entries = this.getAudit()
		if (entries.length === 0) return 'No delegate jobs recorded.'
		const lines = ['## Delegate Audit', '']
		for (const entry of entries.slice(-10)) {
			const duration =
				entry.startedAt && entry.completedAt
					? ` ${((entry.completedAt - entry.startedAt) / 1000).toFixed(1)}s`
					: ''
			const session = entry.sessionID ? ` session=${entry.sessionID}` : ''
			lines.push(
				`- ${entry.jobId} [${entry.status}] ${entry.label} (${entry.kind}/${entry.mode})${duration}${session}`,
			)
		}
		return lines.join('\n')
	}

	renderSummary(): string {
		const jobs = Array.from(this.jobs.values())
		if (jobs.length === 0) return ''
		const counts = {
			pending: this.countByStatus('pending'),
			running: this.countByStatus('running'),
			done: this.countByStatus('done'),
			failed: this.countByStatus('failed'),
			cancelled: this.countByStatus('cancelled'),
			shell: jobs.filter(job => job.mode === 'shell').length,
			session: jobs.filter(job => job.mode === 'session').length,
		}
		const latest = jobs
			.slice()
			.sort((left, right) => lastTouched(right) - lastTouched(left) || right.id.localeCompare(left.id))[0]
		const parts = [
			`jobs=${jobs.length}`,
			`running=${counts.running}`,
			`pending=${counts.pending}`,
			`done=${counts.done}`,
		]
		if (counts.failed > 0) parts.push(`failed=${counts.failed}`)
		if (counts.cancelled > 0) parts.push(`cancelled=${counts.cancelled}`)
		if (counts.session > 0) parts.push(`session=${counts.session}`)
		if (counts.shell > 0) parts.push(`shell=${counts.shell}`)
		if (latest) parts.push(`latest=${latest.id}[${latest.status}/${latest.mode}] ${latest.label}`)
		return parts.join(' | ')
	}

	reset(): void {
		for (const child of this.childProcesses.values()) {
			if (!child.killed) child.kill('SIGTERM')
		}
		this.childProcesses.clear()
		this.jobs.clear()
		this.nextId = 1
		this.persist()
	}

	private countByStatus(status: DelegateJobStatus): number {
		let count = 0
		for (const job of this.jobs.values()) {
			if (job.status === status) count++
		}
		return count
	}

	private createRejected(
		label: string,
		kind: string,
		mode: DelegateJobMode,
		command: string,
		cwd: string,
		reason: string,
	): DelegateJob {
		const id = `D${this.nextId++}`
		const job: DelegateJob = {
			id,
			label,
			kind,
			mode,
			command,
			status: 'failed',
			startedAt: null,
			completedAt: Date.now(),
			exitCode: null,
			output: '',
			error: reason,
			cwd,
		}
		this.jobs.set(id, job)
		this.persist()
		return cloneJob(job)
	}

	private runJob(id: string): void {
		const job = this.jobs.get(id)
		if (!job || job.status !== 'pending' || job.mode !== 'shell') return
		if (this.countByStatus('running') >= this.options.maxConcurrent) return

		job.status = 'running'
		job.startedAt = Date.now()
		this.persist()

		const child = spawn('sh', ['-c', job.command], {
			cwd: job.cwd || this.options.cwd || undefined,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 120_000,
		})
		this.childProcesses.set(id, child)

		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
			if (stdout.length > 100_000) stdout = stdout.slice(-100_000)
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
			if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
		})

		child.on('close', code => {
			this.childProcesses.delete(id)
			job.output = stdout.trim()
			job.error = stderr.trim()
			if (job.status !== 'cancelled') {
				job.exitCode = code ?? 0
				job.status = code === 0 ? 'done' : 'failed'
				job.completedAt = Date.now()
			} else if (!job.completedAt) {
				job.completedAt = Date.now()
			}
			this.persist()
			this.runNextPending()
		})

		child.on('error', err => {
			this.childProcesses.delete(id)
			if (job.status !== 'cancelled') {
				job.status = 'failed'
				job.error = err.message
				job.completedAt = Date.now()
			}
			this.persist()
			this.runNextPending()
		})
	}

	private runNextPending(): void {
		for (const job of this.jobs.values()) {
			if (job.status === 'pending' && job.mode === 'shell') {
				this.runJob(job.id)
				return
			}
		}
	}

	private persist(): void {
		if (!this.options.dataDir) return
		ensureDir(this.options.dataDir)
		const data = {
			nextId: this.nextId,
			jobs: Array.from(this.jobs.entries()),
		}
		writeFileAtomic(join(this.options.dataDir, 'delegate.json'), JSON.stringify(data, null, 2))
	}

	private loadFromDisk(): void {
		if (!this.options.dataDir) return
		const raw = readFileText(join(this.options.dataDir, 'delegate.json'))
		if (!raw) return
		try {
			const data = JSON.parse(raw) as { nextId?: number; jobs?: Array<[string, DelegateJob]> }
			if (typeof data.nextId === 'number') this.nextId = data.nextId
			if (Array.isArray(data.jobs)) {
				for (const [key, value] of data.jobs) {
					this.jobs.set(key, value)
				}
			}
			for (const job of this.jobs.values()) {
				if (job.status === 'running' || job.status === 'pending') {
					job.status = 'cancelled'
					job.completedAt = job.completedAt || Date.now()
					job.error = job.error || 'delegate state restored after restart'
				}
				job.cwd = job.cwd || this.options.cwd
				job.mode = job.mode || 'shell'
			}
		} catch {
			// ignore corrupted data
		}
	}
}

function truncateOutput(output: string): string {
	return output.trim().slice(0, 100_000)
}

function truncateError(output: string): string {
	return output.trim().slice(0, 50_000)
}

function cloneJob(job: DelegateJob): DelegateJob {
	return { ...job }
}

function lastTouched(job: DelegateJob): number {
	return job.completedAt || job.startedAt || 0
}
