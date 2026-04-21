import { readFileText, dirExists, listDirEntries } from '../shared/fs.js'
import { getProjectMemoryDir } from './paths.js'
import { parseFrontmatter } from '../shared/frontmatter.js'
import { statSync } from 'node:fs'

export interface MemoryHeader {
	path: string
	title: string
	description: string
	memoryType: string
	bodyPreview: string
	modifiedAt: number
}

export function scanMemoryFiles(cwd: string, maxFiles: number = 50): MemoryHeader[] {
	const memoryDir = getProjectMemoryDir(cwd)
	if (!dirExists(memoryDir)) return []

	const headers: MemoryHeader[] = []

	for (const entry of listDirEntries(memoryDir)) {
		if (!entry.toLowerCase().endsWith('.md')) continue
		if (entry === 'MEMORY.md') continue

		const fullPath = `${memoryDir}/${entry}`
		const content = readFileText(fullPath)
		if (!content) continue

		let mtime: number
		try {
			mtime = statSync(fullPath).mtimeMs
		} catch {
			mtime = Date.now()
		}

		headers.push(parseMemoryFile(fullPath, content, mtime))
	}

	headers.sort((a, b) => b.modifiedAt - a.modifiedAt)
	return headers.slice(0, maxFiles)
}

function parseMemoryFile(path: string, content: string, modifiedAt: number): MemoryHeader {
	const { data, body } = parseFrontmatter(content)

	const title =
		typeof data['name'] === 'string' && data['name'].trim()
			? data['name'].trim()
			: (path.split('/').pop()?.replace(/\.md$/i, '') ?? 'unknown')

	let description =
		typeof data['description'] === 'string' && data['description'].trim() ? data['description'].trim() : ''

	const memoryType = typeof data['type'] === 'string' ? data['type'] : ''

	if (!description) {
		for (const line of body.split('\n')) {
			const stripped = line.trim()
			if (stripped && !stripped.startsWith('#')) {
				description = stripped.slice(0, 200)
				break
			}
		}
	}

	const bodyLines = body
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('#'))
	const bodyPreview = bodyLines.join(' ').slice(0, 300)

	return {
		path,
		title,
		description,
		memoryType,
		bodyPreview,
		modifiedAt,
	}
}
