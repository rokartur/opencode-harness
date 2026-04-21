import { parse as parseYaml } from 'yaml'

export interface FrontmatterResult {
	data: Record<string, unknown>
	body: string
}

export function parseFrontmatter(content: string): FrontmatterResult {
	if (!content.startsWith('---\n')) {
		return { data: {}, body: content.trim() }
	}

	const endMarker = '\n---\n'
	const endIndex = content.indexOf(endMarker, 4)
	if (endIndex === -1) {
		return { data: {}, body: content.trim() }
	}

	const raw = content.slice(4, endIndex)
	const body = content.slice(endIndex + endMarker.length).trim()

	let data: Record<string, unknown> = {}
	try {
		const parsed = parseYaml(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			data = sanitizeObject(parsed as Record<string, unknown>)
		}
	} catch {
		data = {}
	}

	return { data, body }
}

export function extractDescription(data: Record<string, unknown>, body: string, fallback: string): string {
	const desc = data['description']
	if (typeof desc === 'string' && desc.trim()) return desc.trim()

	for (const line of body.split('\n')) {
		const stripped = line.trim()
		if (!stripped) continue
		if (stripped.startsWith('#')) continue
		return stripped.slice(0, 200)
	}

	return fallback
}

export function coerceStringList(raw: unknown): string[] {
	if (raw == null) return []
	if (typeof raw === 'string') return [raw]
	if (Array.isArray(raw)) return raw.map(v => String(v))
	return []
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = Object.create(null)
	for (const key of Object.keys(obj)) {
		if (DANGEROUS_KEYS.has(key)) continue
		clean[key] = obj[key]
	}
	return clean
}
