import { readFileText, fileExists, dirExists, listDirEntries, walkMarkdownFiles } from '../shared/fs.js'
import { parseFrontmatter, extractDescription } from '../shared/frontmatter.js'
import { MAX_SKILLS_PER_PLUGIN } from '../shared/limits.js'
import type { CompatSkill } from '../shared/types.js'

export function loadSkillsFromPlugin(pluginDir: string, skillsDir: string): CompatSkill[] {
	const root = `${pluginDir}/${skillsDir}`
	if (!dirExists(root)) return []

	const skills: CompatSkill[] = []
	const directSkill = `${root}/SKILL.md`

	if (fileExists(directSkill)) {
		const content = readFileText(directSkill)
		if (content) {
			const { data, body } = parseFrontmatter(content)
			const name = String(data['name'] ?? basename(root))
			const desc = extractDescription(data, body, `Skill: ${name}`)
			skills.push({ name, description: desc.slice(0, 1024), content, source: 'plugin' })
		}
	}

	for (const child of listDirEntries(root)) {
		if (skills.length >= MAX_SKILLS_PER_PLUGIN) break
		const childPath = `${root}/${child}`
		if (!dirExists(childPath)) continue

		const skillFile = `${childPath}/SKILL.md`
		if (!fileExists(skillFile)) continue

		const content = readFileText(skillFile)
		if (!content) continue

		const { data, body } = parseFrontmatter(content)
		const name = String(data['name'] ?? child)
		const desc = extractDescription(data, body, `Skill: ${name}`)
		skills.push({ name, description: desc.slice(0, 1024), content, source: 'plugin' })
	}

	return skills
}

function basename(path: string): string {
	return path.split('/').pop() ?? 'unknown'
}
