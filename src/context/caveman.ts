export type CavemanMode = 'lite' | 'full' | 'ultra'

const PROTECTED_SEGMENT = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+/g
const SAFE_FILLER = /\b(?:please|just|really|basically|actually|simply|quite|very|kind of|sort of)\b/gi
const SAFE_OPENERS = /\b(?:sure|certainly|of course|gladly|absolutely)\b[!,.\s]*/gi
const SAFE_HELPER_PHRASES =
	/\b(?:i can help with that|i can help|let me take a look|let me help|i'd be happy to help(?: with that)?)\b[!,.\s]*/gi
const SAFE_PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
	[/\bi think\b/gi, 'think'],
	[/\bi believe\b/gi, 'believe'],
	[/\bit seems\b/gi, 'seems'],
	[/\bit looks like\b/gi, 'looks like'],
	[/\bmost likely\b/gi, 'likely'],
	[/\bprobably\b/gi, 'likely'],
	[/\bthere (?:is|are)\b/gi, ''],
	[/\bin order to\b/gi, 'to'],
	[/\bfor example\b/gi, 'e.g.'],
	[/\bfor instance\b/gi, 'e.g.'],
	[/\byou need to\b/gi, 'need to'],
	[/\byou can\b/gi, 'can'],
	[/\bit is\b/gi, 'is'],
	[/\bit's\b/gi, 'is'],
]

const MODE_PROMPTS: Record<CavemanMode, string> = {
	lite: [
		'Terse like caveman. Technical substance exact. Only fluff die.',
		'Drop filler, pleasantries, and hedging. Keep grammar mostly intact.',
		'Code, commands, paths, and concrete technical details stay unchanged.',
	].join(' '),
	full: [
		'Terse like caveman. Technical substance exact. Only fluff die.',
		'Drop articles, filler, pleasantries, and hedging.',
		'Fragments OK. Short synonyms. Code unchanged.',
		'Pattern: [thing] [action] [reason]. [next step]. Active every response.',
	].join(' '),
	ultra: [
		'Maximum caveman compression.',
		'Technical substance exact. Fragments preferred. Drop almost all filler and articles.',
		'Code, commands, paths, and exact error strings unchanged.',
	].join(' '),
}

export function buildCavemanSystemPrompt(mode: CavemanMode): string {
	return `# Caveman Mode (${mode})\n\n${MODE_PROMPTS[mode]}`
}

export function compressForCaveman(input: string, mode: CavemanMode = 'full'): string {
	if (!input.trim()) return input

	const protectedSegments: string[] = []
	const masked = input.replace(PROTECTED_SEGMENT, segment => {
		const placeholder = `__CAVEMAN_${protectedSegments.length}__`
		protectedSegments.push(segment)
		return placeholder
	})

	const compressed = masked
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(line => compressLine(line, mode))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')

	const restored = protectedSegments.reduce(
		(text, segment, index) => text.replaceAll(`__CAVEMAN_${index}__`, segment),
		compressed,
	)

	return restored.length < input.length ? restored : input
}

function compressLine(line: string, mode: CavemanMode): string {
	if (!line.trim()) return line

	const trimmed = line.trim()
	if (trimmed === '---' || /^\|/.test(trimmed)) return line

	const match = line.match(/^(\s*(?:[-*+]\s+|\d+\.\s+|#+\s+|>\s+)?)?(.*)$/)
	const prefix = match?.[1] ?? ''
	const body = match?.[2] ?? line

	if (!/[A-Za-z]/.test(body)) return line

	const compressedBody = compressTextBody(body, mode)
	return compressedBody ? `${prefix}${compressedBody}` : prefix.trimEnd()
}

function compressTextBody(body: string, mode: CavemanMode): string {
	let text = ` ${body} `

	text = text.replace(SAFE_OPENERS, ' ')
	text = text.replace(SAFE_HELPER_PHRASES, ' ')
	text = text.replace(SAFE_FILLER, ' ')

	for (const [pattern, replacement] of SAFE_PHRASE_REPLACEMENTS) {
		text = text.replace(pattern, replacement)
	}

	if (mode !== 'lite') {
		text = text.replace(/\b(?:the|a|an)\b/gi, ' ')
	}

	if (mode === 'ultra') {
		text = text.replace(/\b(?:that|which)\b/gi, ' ')
		text = text.replace(/\bbecause\b/gi, 'cause')
	}

	return text
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')
		.replace(/\s{2,}/g, ' ')
		.trim()
}
