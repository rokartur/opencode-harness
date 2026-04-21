import { join } from 'node:path'
import { readFileText, fileExists, dirExists, listDirEntries } from '../shared/fs.js'
import { MAX_CHARS_PER_FILE } from '../shared/limits.js'

export interface ExtraContext {
	label: string
	content: string
	source: string
}

export interface ExtraContextOptions {
	issue?: boolean
	prComments?: boolean
	activeRepo?: boolean
}

export function discoverExtraContext(cwd: string, options: ExtraContextOptions = {}): ExtraContext[] {
	const contexts: ExtraContext[] = []

	const sources: Array<{ enabled: boolean; path: string; label: string }> = [
		{
			enabled: options.issue !== false,
			path: join(cwd, '.openharness', 'issue.md'),
			label: 'Issue Context',
		},
		{
			enabled: options.prComments !== false,
			path: join(cwd, '.openharness', 'pr_comments.md'),
			label: 'Pull Request Comments',
		},
		{
			enabled: options.activeRepo !== false,
			path: join(cwd, '.openharness', 'autopilot', 'active_repo_context.md'),
			label: 'Active Repo Context',
		},
	]

	for (const { enabled, path, label } of sources) {
		if (!enabled) continue
		const content = readFileText(path)
		if (content && content.trim()) {
			contexts.push({
				label,
				content: content.trim().slice(0, MAX_CHARS_PER_FILE),
				source: path,
			})
		}
	}

	return contexts
}

export function discoverClaudeRules(cwd: string): ExtraContext[] {
	const contexts: ExtraContext[] = []
	const rulesDir = join(cwd, '.claude', 'rules')

	if (!dirExists(rulesDir)) return contexts

	for (const entry of listDirEntries(rulesDir)) {
		if (!entry.toLowerCase().endsWith('.md')) continue
		const full = join(rulesDir, entry)
		const content = readFileText(full)
		if (content && content.trim()) {
			contexts.push({
				label: `Rule: ${entry}`,
				content: content.trim().slice(0, MAX_CHARS_PER_FILE),
				source: full,
			})
		}
	}

	return contexts
}
