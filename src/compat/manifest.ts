import { readFileText, findManifestPath, dirExists, listDirEntries } from '../shared/fs.js'
import { MAX_CHARS_PER_FILE } from '../shared/limits.js'
import type { CompatManifest, PluginDiagnostic } from '../shared/types.js'

export function parseManifest(pluginDir: string): { manifest: CompatManifest; diagnostics: PluginDiagnostic[] } | null {
	const manifestPath = findManifestPath(pluginDir)
	if (!manifestPath) return null

	const raw = readFileText(manifestPath)
	if (!raw) return null

	const diagnostics: PluginDiagnostic[] = []

	try {
		const json = JSON.parse(raw) as Record<string, unknown>

		if (!json['name'] || typeof json['name'] !== 'string') {
			diagnostics.push({
				level: 'error',
				pluginName: String(json['name'] ?? 'unknown'),
				message: "Missing or invalid 'name' field in manifest",
			})
			return null
		}

		const manifest: CompatManifest = {
			name: json['name'],
			version: typeof json['version'] === 'string' ? json['version'] : '0.0.0',
			description: typeof json['description'] === 'string' ? json['description'] : '',
			enabledByDefault: typeof json['enabled_by_default'] === 'boolean' ? json['enabled_by_default'] : true,
			skillsDir: typeof json['skills_dir'] === 'string' ? json['skills_dir'] : 'skills',
			hooksFile: typeof json['hooks_file'] === 'string' ? json['hooks_file'] : 'hooks.json',
			mcpFile: typeof json['mcp_file'] === 'string' ? json['mcp_file'] : 'mcp.json',
			commands: json['commands'] as string | string[] | Record<string, unknown> | undefined,
			agents: json['agents'] as string | string[] | undefined,
			skills: json['skills'] as string | string[] | undefined,
			hooks: json['hooks'] as string | Record<string, unknown> | unknown[] | undefined,
		}

		return { manifest, diagnostics }
	} catch (e) {
		diagnostics.push({
			level: 'error',
			pluginName: basename(pluginDir),
			message: 'Failed to parse manifest JSON',
			detail: String(e),
		})
		return { manifest: fallbackManifest(pluginDir), diagnostics }
	}
}

function fallbackManifest(pluginDir: string): CompatManifest {
	return {
		name: basename(pluginDir),
		version: '0.0.0',
		description: '',
		enabledByDefault: true,
		skillsDir: 'skills',
		hooksFile: 'hooks.json',
		mcpFile: 'mcp.json',
	}
}

function basename(path: string): string {
	return path.split('/').pop() ?? 'unknown'
}
