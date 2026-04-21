import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectMemoryDir, getMemoryEntrypoint } from './paths.js'
import { ensureDir, fileExists, withFileLock, writeFileAtomic } from '../shared/fs.js'

const MAX_MEMORY_CONTENT_SIZE = 256 * 1024
const MAX_MEMORY_TITLE_LENGTH = 200

export function listMemoryFiles(cwd: string): string[] {
	const dir = getProjectMemoryDir(cwd)
	ensureDir(dir)
	return readdirSync(dir)
		.filter(f => f.endsWith('.md'))
		.sort()
		.map(f => join(dir, f))
}

export function readMemoryFile(path: string): string | null {
	try {
		return readFileSync(path, 'utf-8')
	} catch {
		return null
	}
}

export function writeMemoryFile(cwd: string, title: string, content: string): string {
	if (!title || !title.trim()) title = 'untitled'
	title = title.slice(0, MAX_MEMORY_TITLE_LENGTH)
	content = content.slice(0, MAX_MEMORY_CONTENT_SIZE)

	const dir = getProjectMemoryDir(cwd)
	ensureDir(dir)
	const slug = sanitizeSlug(title)
	const filePath = join(dir, `${slug}.md`)

	withFileLock(getMemoryLockPath(cwd), () => {
		const header = `---\nname: ${title.replace(/\n/g, ' ')}\n---\n`
		writeFileAtomic(filePath, header + content.trim() + '\n')

		const entrypoint = getMemoryEntrypoint(cwd)
		let existing = '# Memory Index\n'
		if (fileExists(entrypoint)) {
			existing = readFileSync(entrypoint, 'utf-8')
		}
		if (!existing.includes(slug + '.md')) {
			existing = existing.trimEnd() + `\n- [${title.replace(/\n/g, ' ')}](${slug}.md)\n`
			writeFileAtomic(entrypoint, existing)
		}
	})

	return filePath
}

export function deleteMemoryFile(cwd: string, name: string): boolean {
	if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
		return false
	}

	const dir = getProjectMemoryDir(cwd)
	let matches: string[]
	try {
		matches = readdirSync(dir).filter(f => f === name || f.replace(/\.md$/i, '') === name)
	} catch {
		return false
	}

	if (!matches.length) return false

	const filePath = join(dir, matches[0])
	try {
		withFileLock(getMemoryLockPath(cwd), () => {
			if (statSync(filePath).isFile()) {
				unlinkSync(filePath)
			}

			const entrypoint = getMemoryEntrypoint(cwd)
			if (fileExists(entrypoint)) {
				const lines = readFileSync(entrypoint, 'utf-8')
					.split('\n')
					.filter(line => !line.includes(matches[0]))
				writeFileAtomic(entrypoint, lines.join('\n').trimEnd() + '\n')
			}
		})
	} catch {
		return false
	}

	return true
}

function getMemoryLockPath(cwd: string): string {
	return join(getProjectMemoryDir(cwd), '.memory.lock')
}

function sanitizeSlug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'memory'
	)
}
