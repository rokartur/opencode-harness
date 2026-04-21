import { readFileText, walkMarkdownFiles, dirExists, fileExists } from '../shared/fs.js'
import { parseFrontmatter, extractDescription, coerceStringList } from '../shared/frontmatter.js'
import { MAX_CHARS_PER_AGENT_PROMPT, MAX_AGENTS_PER_PLUGIN } from '../shared/limits.js'
import type { CompatAgent, PluginDiagnostic } from '../shared/types.js'

const VALID_MODES: ReadonlySet<string> = new Set(['primary', 'subagent'])

function normalizeAgentMode(raw: string): 'primary' | 'subagent' {
	const lower = raw.toLowerCase()
	if (lower === 'primary') return 'primary'
	if (lower === 'all') return 'primary'
	return 'subagent'
}

export function loadAgentsFromPlugin(
	pluginDir: string,
	pluginName: string,
	manifestAgents?: string | string[],
	diagnostics: PluginDiagnostic[] = [],
): CompatAgent[] {
	const agents: CompatAgent[] = []
	const seen = new Set<string>()

	const defaultDir = `${pluginDir}/agents`
	loadAgentsFromDir(defaultDir, pluginName, agents, seen, diagnostics)

	for (const raw of coerceStringList(manifestAgents)) {
		const target = `${pluginDir}/${raw}`
		loadAgentsFromDirOrFile(target, pluginName, agents, seen, diagnostics)
	}

	return agents.slice(0, MAX_AGENTS_PER_PLUGIN)
}

function loadAgentsFromDir(
	dir: string,
	pluginName: string,
	agents: CompatAgent[],
	seen: Set<string>,
	diagnostics: PluginDiagnostic[],
): void {
	const files = walkMarkdownFiles(dir, false)

	for (const filePath of files) {
		const relative = filePath.slice(dir.length + 1)
		const parts = relative.replace(/\.md$/i, '').split('/')
		const namespace = parts.slice(0, -1)
		const baseName = parts[parts.length - 1]
		const name = [pluginName, ...namespace, baseName].filter(Boolean).join(':')

		if (seen.has(name)) continue
		seen.add(name)

		const agent = parseAgentFile(filePath, name, pluginName, diagnostics)
		if (agent) agents.push(agent)
	}
}

function loadAgentsFromDirOrFile(
	target: string,
	pluginName: string,
	agents: CompatAgent[],
	seen: Set<string>,
	diagnostics: PluginDiagnostic[],
): void {
	if (dirExists(target)) {
		loadAgentsFromDir(target, pluginName, agents, seen, diagnostics)
		return
	}

	if (!fileExists(target) || !target.toLowerCase().endsWith('.md')) return
	const stem = target.replace(/\.md$/i, '').split('/').pop()!
	const name = `${pluginName}:${stem}`
	if (seen.has(name)) return
	seen.add(name)

	const agent = parseAgentFile(target, name, pluginName, diagnostics)
	if (agent) agents.push(agent)
}

function parseAgentFile(
	filePath: string,
	agentName: string,
	pluginName: string,
	diagnostics: PluginDiagnostic[],
): CompatAgent | null {
	const raw = readFileText(filePath)
	if (!raw) return null

	const { data, body } = parseFrontmatter(raw)
	const desc = extractDescription(data, body, `Agent from ${pluginName}`)
	reportUnsupportedAgentFields(agentName, pluginName, data, diagnostics)

	const modeRaw = String(data['mode'] ?? 'subagent').toLowerCase()
	const mode = VALID_MODES.has(modeRaw) ? normalizeAgentMode(modeRaw) : 'subagent'

	const temperature = typeof data['temperature'] === 'number' ? data['temperature'] : undefined
	const stepsRaw = data['maxSteps'] ?? data['steps']
	const steps = typeof stepsRaw === 'number' && stepsRaw > 0 ? stepsRaw : undefined
	const color = typeof data['color'] === 'string' ? data['color'] : undefined
	const modelRaw = typeof data['model'] === 'string' ? data['model'] : undefined
	const model = modelRaw && modelRaw.toLowerCase() !== 'inherit' ? modelRaw : undefined

	return {
		name: agentName,
		description: desc.slice(0, 1024),
		prompt: body.slice(0, MAX_CHARS_PER_AGENT_PROMPT),
		model,
		color,
		mode,
		temperature,
		steps,
		source: 'plugin',
	}
}

const UNSUPPORTED_AGENT_FIELDS = [
	'background',
	'background_intent',
	'permissions',
	'permission',
	'memory_scope',
	'memoryScope',
	'isolation',
	'isolation_mode',
]

function reportUnsupportedAgentFields(
	agentName: string,
	pluginName: string,
	data: Record<string, unknown>,
	diagnostics: PluginDiagnostic[],
): void {
	const unsupported = UNSUPPORTED_AGENT_FIELDS.filter(key => key in data)
	if (unsupported.length === 0) return

	diagnostics.push({
		level: 'warn',
		pluginName,
		message: `Degraded agent mapping for '${agentName}': unsupported fields ${unsupported.join(', ')}`,
	})
}
