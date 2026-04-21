import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import { listMemoryFiles, readMemoryFile, writeMemoryFile, deleteMemoryFile } from './manager.js'
import { findRelevantMemories } from './search.js'
import { getMemoryEntrypoint } from './paths.js'
import { readFileText, fileExists } from '../shared/fs.js'

const z = tool.schema

export const memoryListTool: ToolDefinition = tool({
	description: 'List all persistent memory files for the current project (OpenHarness compatible).',
	args: {},
	async execute(_args, ctx) {
		const files = listMemoryFiles(ctx.directory)
		if (!files.length) return 'No memory files found.'
		return files.map(f => f.split('/').pop()).join('\n')
	},
})

export const memoryReadTool: ToolDefinition = tool({
	description: 'Read the content of a specific persistent memory file by name (OpenHarness compatible).',
	args: {
		name: z.string().describe('Name of the memory file (with or without .md extension)'),
	},
	async execute(args, ctx) {
		const files = listMemoryFiles(ctx.directory)
		const match = files.find(f => f.endsWith(`/${args.name}`) || f.endsWith(`/${args.name}.md`))
		if (!match) return `Memory file '${args.name}' not found.`
		const content = readMemoryFile(match)
		return content ?? `Failed to read memory file '${args.name}'.`
	},
})

export const memorySearchTool: ToolDefinition = tool({
	description: 'Search persistent memory files for content relevant to a query (OpenHarness compatible).',
	args: {
		query: z.string().describe('Search query to find relevant memory entries'),
	},
	async execute(args, ctx) {
		const results = findRelevantMemories(args.query, ctx.directory, 5)
		if (!results.length) return 'No relevant memories found.'

		const lines = results.map(h => {
			const name = h.path.split('/').pop()
			return `## ${h.title} (${name})\n${h.description}`
		})
		return lines.join('\n\n')
	},
})

export const memoryWriteTool: ToolDefinition = tool({
	description: 'Create or update a persistent memory file for the current project (OpenHarness compatible).',
	args: {
		title: z.string().describe('Title for the memory entry'),
		content: z.string().describe('Markdown content to store'),
	},
	async execute(args, ctx) {
		const path = writeMemoryFile(ctx.directory, args.title, args.content)
		return `Memory written to ${path.split('/').pop()}`
	},
})

export const memoryDeleteTool: ToolDefinition = tool({
	description: 'Delete a persistent memory file by name (OpenHarness compatible).',
	args: {
		name: z.string().describe('Name of the memory file to delete'),
	},
	async execute(args, ctx) {
		const ok = deleteMemoryFile(ctx.directory, args.name)
		return ok ? `Memory file '${args.name}' deleted.` : `Memory file '${args.name}' not found.`
	},
})

export const memoryIndexTool: ToolDefinition = tool({
	description: 'Read the MEMORY.md index file for the current project (OpenHarness compatible).',
	args: {},
	async execute(_args, ctx) {
		const entrypoint = getMemoryEntrypoint(ctx.directory)
		if (!fileExists(entrypoint)) return 'MEMORY.md does not exist yet.'
		const content = readFileText(entrypoint)
		return content ?? 'Failed to read MEMORY.md.'
	},
})
