/**
 * Plain text in and out of the RTF that Scrivener stores documents as.
 *
 * Full RTF is a deep format and this is deliberately not an implementation of
 * it. Manuscript text is paragraphs of prose, so the conversion covers exactly
 * that, and reading is tolerant of the far richer files Scrivener itself writes
 * — fonts, tab stops, colour tables — by discarding formatting rather than
 * attempting to represent it.
 */

const HEADER = [
	'{\\rtf1\\ansi\\ansicpg1252\\cocoartf1404\\cocoasubrtf340',
	'{\\fonttbl\\f0\\froman\\fcharset0 Palatino-Roman;}',
	'{\\colortbl;\\red255\\green255\\blue255;}',
	'\\deftab720',
	'\\pard\\pardeftab720\\partightenfactor0',
	'',
	'\\f0\\fs24 \\cf0 ',
].join('\n');

/** Escape a run of plain text for inclusion in an RTF body. */
function escapeRun(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/\{/g, '\\{')
		.replace(/\}/g, '\\}')
		// RTF carries non-ASCII as a signed 16-bit \uN escape plus an ASCII
		// fallback, which is the '?' each one is followed by.
		.replace(/[\u0080-\uFFFF]/g, (char) => `\\u${char.charCodeAt(0)}?`);
}

export function textToRtf(text: string): string {
	const body = text
		.split(/\r?\n/)
		.map(escapeRun)
		// A trailing backslash before the newline is RTF's line break; Scrivener
		// writes paragraphs this way rather than with \par.
		.join('\\\n');
	return `${HEADER}${body}}`;
}

/**
 * Groups that describe the document rather than contain it.
 *
 * Dropping these by pattern-matching the file does not work, because a group can
 * nest and the closing brace that matches is not the next one. They are skipped
 * by depth during the scan below instead — the font table is the reason, since
 * `{\fonttbl\f0\froman\fcharset0 Palatino-Roman;}` otherwise contributes the
 * typeface name to the first line of the prose.
 */
const NON_TEXT_GROUPS = new Set([
	'fonttbl',
	'colortbl',
	'stylesheet',
	'info',
	'pgdsctbl',
	'listtable',
	'listoverridetable',
	'listtext',
	'rsidtbl',
	'generator',
	'themedata',
	'colorschememapping',
	'latentstyles',
	'datastore',
	'xmlnstbl',
	'filetbl',
	'revtbl',
	'pict',
	'shppict',
	'nonshppict',
]);

/**
 * Recover the plain text from an RTF file.
 *
 * A single pass with a group stack, rather than a series of replacements: the
 * format nests, and every regex approach to it fails on a document slightly
 * richer than the one it was written against. Tolerant by design, because it has
 * to read files Scrivener wrote — font tables, tab stops, hex-escaped symbols —
 * as well as the plain ones written here.
 */
export function rtfToText(rtf: string): string {
	const out: string[] = [];
	let index = 0;
	let depth = 0;
	/** Depth of the outermost group being skipped, while inside one. */
	let skipping: number | null = null;

	const emit = (value: string): void => {
		if (skipping === null) out.push(value);
	};

	while (index < rtf.length) {
		const char = rtf[index];

		if (char === '{') {
			depth += 1;
			index += 1;
			if (skipping === null) {
				// An ignorable destination (`{\*\foo`) or a known non-text group.
				const head = /^(\\\*)?\\([a-zA-Z]+)/.exec(rtf.slice(index));
				const ignorable = head?.[1] !== undefined;
				const name = head?.[2];
				if (ignorable || (name !== undefined && NON_TEXT_GROUPS.has(name))) {
					skipping = depth;
				}
			}
			continue;
		}

		if (char === '}') {
			if (skipping === depth) skipping = null;
			depth -= 1;
			index += 1;
			continue;
		}

		if (char === '\\') {
			const next = rtf[index + 1];

			// Escaped literal. Consumed even while skipping, so that a `\}` inside a
			// group being dropped does not end it early.
			if (next !== undefined && '\\{}'.includes(next)) {
				emit(next);
				index += 2;
				continue;
			}
			// A backslash before a newline is a paragraph break.
			if (next === '\n' || next === '\r') {
				emit('\n');
				index += 2;
				continue;
			}
			const rest = rtf.slice(index);

			const hex = /^\\'([0-9a-fA-F]{2})/.exec(rest);
			if (hex?.[1] !== undefined) {
				emit(String.fromCharCode(parseInt(hex[1], 16)));
				index += hex[0].length;
				continue;
			}
			// Unicode, with the ASCII fallback character that follows it discarded.
			const unicode = /^\\u(-?\d+)\s?\??/.exec(rest);
			if (unicode?.[1] !== undefined) {
				const code = Number(unicode[1]);
				emit(String.fromCharCode(code < 0 ? code + 65536 : code));
				index += unicode[0].length;
				continue;
			}
			// Control word, with an optional argument and one optional trailing space.
			const control = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rest);
			if (control?.[1] !== undefined) {
				if (control[1] === 'par' || control[1] === 'line') emit('\n');
				if (control[1] === 'tab') emit('\t');
				index += control[0].length;
				continue;
			}
			index += 1;
			continue;
		}

		// Literal newlines in the file are formatting, not content.
		if (char === '\n' || char === '\r') {
			index += 1;
			continue;
		}

		emit(char ?? '');
		index += 1;
	}

	// Trailing whitespace only. Runs of blank lines are content — ASCII
	// diagrams and deliberately spaced prose use them — and collapsing runs
	// here once made every document containing one read as forever-changed.
	return out.join('').replace(/\s+$/u, '');
}
