/**
 * A Scrivener project, held open.
 *
 * A .scriv package is a directory, not a document: the binder lives in one XML
 * file, and each item's text, synopsis and notes live in a folder named after
 * the item's UUID. Four things about that arrangement are easy to get wrong, and
 * each one fails quietly — the write succeeds, the file changes, and Scrivener
 * shows the author nothing:
 *
 *   1. Synopsis is `Files/Data/<UUID>/synopsis.txt`, plain text, and notes are
 *      `notes.rtf` beside it. Neither has any representation in the binder XML.
 *   2. A label or status on an item is the *number* `LabelID`/`StatusID`,
 *      pointing into the project's own definitions. Writing the human-readable
 *      title where the number belongs leaves the item unlabelled.
 *   3. Identity and kind are XML attributes, so the binder has to be edited in
 *      place rather than rebuilt (see xml.ts).
 *   4. `Files/Data/docs.checksum` records a SHA-1 per file, under a lowercased
 *      UUID, and is how Scrivener notices outside edits.
 *
 * The project is parsed once and kept, because it is opened per operation
 * otherwise and a manuscript is not a cheap parse.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
	buildXml,
	childrenOf,
	ensureChild,
	findChild,
	findDescendant,
	getAttr,
	parseXml,
	removeChild,
	setAttr,
	setText,
	stripLayoutWhitespace,
	tagOf,
	textElement,
	textOf,
	type XmlNode,
} from './xml.js';
import { rtfToText, textToRtf } from './rtf.js';

export interface TaxonomyEntry {
	readonly id: string;
	readonly title: string;
	readonly color?: string;
}

/**
 * Fields spread from parsed tool arguments, where an absent field arrives as an
 * explicit `undefined`, so each one admits it rather than forcing callers to
 * rebuild the object key by key.
 */
export interface DocumentFields {
	readonly label?: string | undefined;
	readonly status?: string | undefined;
	readonly synopsis?: string | undefined;
	readonly notes?: string | undefined;
	readonly content?: string | undefined;
	readonly keywords?: readonly string[] | undefined;
	readonly includeInCompile?: boolean | undefined;
}

export interface BinderView {
	readonly id: string;
	readonly title: string;
	readonly type: string;
	readonly label?: string;
	readonly status?: string;
	readonly synopsis?: string;
	readonly includeInCompile?: boolean;
	readonly children?: BinderView[];
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Scrivener's timestamp form: `2026-08-08 21:07:32 +0700`. */
function stamp(date = new Date()): string {
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const absolute = Math.abs(offset);
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
		`${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
	);
}

function newUuid(): string {
	return crypto.randomUUID().toUpperCase();
}

/** Depth-first search for a BinderItem matching the test. */
function search(nodes: XmlNode[], test: (node: XmlNode) => boolean): XmlNode | undefined {
	for (const node of nodes) {
		if (tagOf(node) === 'BinderItem' && test(node)) return node;
		const found = search(childrenOf(node), test);
		if (found) return found;
	}
	return undefined;
}

const digestOf = (text: string): string => createHash('sha1').update(text).digest('hex');

export class ScrivenerProject {
	private dirty = false;
	private readonly checksums = new Map<string, string>();
	private checksumsLoaded = false;
	/**
	 * Digest of the .scrivx bytes this instance parsed. The invariant every
	 * write obeys: never replace bytes you have not seen. A content digest
	 * rather than an mtime, because sync clients preserve timestamps.
	 */
	private parsedDigest = '';

	private constructor(
		readonly path: string,
		private readonly scrivxPath: string,
		private tree: XmlNode[]
	) {}

	static async open(path: string): Promise<ScrivenerProject> {
		const entries = await readdir(path);
		const scrivx = entries.find((entry) => entry.endsWith('.scrivx'));
		if (scrivx === undefined) {
			throw new Error(`Not a Scrivener project (no .scrivx inside): ${path}`);
		}
		const scrivxPath = join(path, scrivx);
		const raw = await readFile(scrivxPath, 'utf8');
		const tree = stripLayoutWhitespace(parseXml(raw));
		if (findDescendant(tree, 'Binder') === undefined) {
			throw new Error(`No <Binder> in ${scrivx}; the project may be damaged.`);
		}
		const project = new ScrivenerProject(path, scrivxPath, tree);
		project.parsedDigest = digestOf(raw);
		return project;
	}

	/**
	 * The .scrivx changed on disk after this instance parsed it — Scrivener's
	 * auto-save, a sync client, another tool. Saving now would overwrite that
	 * writer's work with a stale tree, so save() refuses while this is true.
	 */
	async changedOnDisk(): Promise<boolean> {
		return digestOf(await readFile(this.scrivxPath, 'utf8')) !== this.parsedDigest;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	private root(): XmlNode {
		const binder = findDescendant(this.tree, 'Binder');
		if (binder === undefined) throw new Error('Binder disappeared from the parsed project.');
		return binder;
	}

	// ---- taxonomy -----------------------------------------------------------

	private taxonomy(settings: string, container: string, entry: string): TaxonomyEntry[] {
		const node = findDescendant(this.tree, settings);
		if (node === undefined) return [];
		const items = findChild(node, container);
		if (items === undefined) return [];
		return childrenOf(items)
			.filter((child) => tagOf(child) === entry)
			.map((child) => {
				const color = getAttr(child, 'Color');
				return {
					id: getAttr(child, 'ID') ?? '',
					title: textOf(child),
					...(color === undefined ? {} : { color }),
				};
			});
	}

	labels(): TaxonomyEntry[] {
		return this.taxonomy('LabelSettings', 'Labels', 'Label');
	}

	statuses(): TaxonomyEntry[] {
		return this.taxonomy('StatusSettings', 'StatusItems', 'Status');
	}

	/** Resolve a label or status title to the id an item must reference. */
	private resolveId(kind: 'label' | 'status', title: string): string {
		const table = kind === 'label' ? this.labels() : this.statuses();
		const wanted = title.trim().toLowerCase();
		const hit = table.find((candidate) => candidate.title.trim().toLowerCase() === wanted);
		if (hit === undefined) {
			const known = table.map((candidate) => candidate.title).join(', ');
			throw new Error(
				`Unknown ${kind} "${title}". Define it in the project first. Known: ${known}`
			);
		}
		return hit.id;
	}

	// ---- binder -------------------------------------------------------------

	/**
	 * The folder a manuscript outline belongs under. Scrivener marks it with a
	 * type of its own rather than a reserved title, so the type is authoritative
	 * and the title match is only a fallback for unusual projects.
	 */
	resolveRoot(which: 'manuscript' | 'binder' | string): XmlNode {
		if (which === 'binder') return this.root();

		if (which === 'manuscript') {
			const byType = search(childrenOf(this.root()), (node) => getAttr(node, 'Type') === 'DraftFolder');
			if (byType) return byType;
			const byTitle = search(childrenOf(this.root()), (node) => {
				const title = this.titleOf(node).toLowerCase();
				return title === 'manuscript' || title === 'draft';
			});
			if (byTitle) return byTitle;
			throw new Error('No manuscript folder in this project.');
		}

		const byId = search(childrenOf(this.root()), (node) => getAttr(node, 'UUID') === which);
		if (byId) return byId;
		throw new Error(`No binder item with id ${which}`);
	}

	titleOf(item: XmlNode): string {
		const title = findChild(item, 'Title');
		return title === undefined ? '' : textOf(title);
	}

	/** The live child-item array of a folder, created if the folder has none. */
	childItems(item: XmlNode): XmlNode[] {
		if (tagOf(item) === 'Binder') {
			return childrenOf(item).filter((child) => tagOf(child) === 'BinderItem');
		}
		const children = ensureChild(item, 'Children');
		return childrenOf(children);
	}

	createItem(parent: XmlNode, title: string, type: 'Folder' | 'Text'): XmlNode {
		const now = stamp();
		const item: XmlNode = { BinderItem: [textElement('Title', title)] };
		setAttr(item, 'UUID', newUuid());
		setAttr(item, 'Type', type);
		setAttr(item, 'Created', now);
		setAttr(item, 'Modified', now);

		if (tagOf(parent) === 'Binder') {
			childrenOf(parent).push(item);
		} else {
			this.childItems(parent).push(item);
		}
		this.dirty = true;
		return item;
	}

	/**
	 * Apply metadata to an item, returning the field names that changed.
	 *
	 * Text-valued Label and Status elements are removed when an id is written,
	 * because a project edited by a tool that stored titles there keeps both, and
	 * Scrivener reads the one that is wrong.
	 */
	applyMetadata(item: XmlNode, fields: DocumentFields): string[] {
		const changed: string[] = [];
		const metadata = ensureChild(item, 'MetaData');

		const setIdField = (kind: 'label' | 'status', title: string): void => {
			const tag = kind === 'label' ? 'LabelID' : 'StatusID';
			const id = this.resolveId(kind, title);
			const existing = findChild(metadata, tag);
			if (existing !== undefined && textOf(existing) === id) return;
			if (existing === undefined) {
				childrenOf(metadata).push(textElement(tag, id));
			} else {
				setText(existing, id);
			}
			removeChild(metadata, kind === 'label' ? 'Label' : 'Status');
			changed.push(kind);
		};

		if (fields.label !== undefined) setIdField('label', fields.label);
		if (fields.status !== undefined) setIdField('status', fields.status);

		if (fields.includeInCompile !== undefined) {
			const value = fields.includeInCompile ? 'Yes' : 'No';
			const existing = findChild(metadata, 'IncludeInCompile');
			if (existing === undefined) {
				childrenOf(metadata).push(textElement('IncludeInCompile', value));
				changed.push('includeInCompile');
			} else if (textOf(existing) !== value) {
				setText(existing, value);
				changed.push('includeInCompile');
			}
		}

		if (fields.keywords !== undefined) {
			const existing = findChild(metadata, 'Keywords');
			const current =
				existing === undefined
					? []
					: childrenOf(existing)
							.filter((child) => tagOf(child) === 'Keyword')
							.map((child) => textOf(child));
			const wanted = fields.keywords;
			const equal =
				current.length === wanted.length && current.every((word, i) => word === wanted[i]);
			if (!equal) {
				removeChild(metadata, 'Keywords');
				if (wanted.length > 0) {
					childrenOf(metadata).push({
						Keywords: wanted.map((word) => textElement('Keyword', word)),
					});
				}
				changed.push('keywords');
			}
		}

		if (changed.length > 0) {
			setAttr(item, 'Modified', stamp());
			this.dirty = true;
		}
		return changed;
	}

	read(from?: XmlNode): BinderView[] {
		const labelById = new Map(this.labels().map((entry) => [entry.id, entry.title]));
		const statusById = new Map(this.statuses().map((entry) => [entry.id, entry.title]));

		const view = (item: XmlNode): BinderView => {
			const metadata = findChild(item, 'MetaData');
			const field = (tag: string): string | undefined => {
				if (metadata === undefined) return undefined;
				const node = findChild(metadata, tag);
				return node === undefined ? undefined : textOf(node);
			};
			const labelId = field('LabelID');
			const statusId = field('StatusID');
			const compile = field('IncludeInCompile');
			const kids = findChild(item, 'Children');
			const label = labelId === undefined ? undefined : labelById.get(labelId);
			const status = statusId === undefined ? undefined : statusById.get(statusId);

			return {
				id: getAttr(item, 'UUID') ?? '',
				title: this.titleOf(item),
				type: getAttr(item, 'Type') ?? 'Text',
				...(label === undefined ? {} : { label }),
				...(status === undefined ? {} : { status }),
				...(compile === undefined ? {} : { includeInCompile: compile === 'Yes' }),
				...(kids === undefined
					? {}
					: {
							children: childrenOf(kids)
								.filter((child) => tagOf(child) === 'BinderItem')
								.map(view),
						}),
			};
		};

		const start = from ?? this.root();
		const items =
			tagOf(start) === 'Binder'
				? childrenOf(start).filter((child) => tagOf(child) === 'BinderItem')
				: [start];
		return items.map(view);
	}

	// ---- per-document files -------------------------------------------------

	private dataDir(id: string): string {
		return join(this.path, 'Files', 'Data', id);
	}

	private async loadChecksums(): Promise<void> {
		if (this.checksumsLoaded) return;
		this.checksumsLoaded = true;
		try {
			const raw = await readFile(join(this.path, 'Files', 'Data', 'docs.checksum'), 'utf8');
			for (const line of raw.split(/\r?\n/)) {
				const split = line.lastIndexOf('=');
				if (split > 0) this.checksums.set(line.slice(0, split), line.slice(split + 1));
			}
		} catch {
			// A project that has never been saved by Scrivener has no checksum file.
		}
	}

	private async writeDocFile(id: string, name: string, body: string): Promise<void> {
		await this.loadChecksums();
		const folder = this.dataDir(id);
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, name), body, 'utf8');
		this.checksums.set(
			`${id.toLowerCase()}/${name}`,
			createHash('sha1').update(body, 'utf8').digest('hex')
		);
	}

	async writeFields(id: string, fields: DocumentFields): Promise<string[]> {
		const written: string[] = [];
		if (fields.synopsis !== undefined) {
			await this.writeDocFile(id, 'synopsis.txt', fields.synopsis);
			written.push('synopsis');
		}
		if (fields.notes !== undefined) {
			await this.writeDocFile(id, 'notes.rtf', textToRtf(fields.notes));
			written.push('notes');
		}
		if (fields.content !== undefined) {
			await this.writeDocFile(id, 'content.rtf', textToRtf(fields.content));
			written.push('content');
		}
		return written;
	}

	async readText(id: string): Promise<string> {
		try {
			return rtfToText(await readFile(join(this.dataDir(id), 'content.rtf'), 'utf8'));
		} catch {
			return '';
		}
	}

	async readSynopsis(id: string): Promise<string> {
		try {
			return await readFile(join(this.dataDir(id), 'synopsis.txt'), 'utf8');
		} catch {
			return '';
		}
	}

	async readNotes(id: string): Promise<string> {
		try {
			return rtfToText(await readFile(join(this.dataDir(id), 'notes.rtf'), 'utf8'));
		} catch {
			return '';
		}
	}

	// ---- persistence --------------------------------------------------------

	async save(): Promise<boolean> {
		if (!this.dirty && this.checksums.size === 0) return false;

		if (this.dirty) {
			if (await this.changedOnDisk()) {
				throw new Error(
					`${this.scrivxPath} changed on disk after it was parsed — most likely Scrivener has the project open and auto-saved, or a sync client delivered a newer version. Writing now would destroy those changes. Nothing was written. Close Scrivener (or let the sync settle), then retry; the project will be re-read automatically.`
				);
			}
			const project = findDescendant(this.tree, 'ScrivenerProject');
			if (project) setAttr(project, 'Modified', stamp());
			const output = buildXml(this.tree);
			await writeFile(this.scrivxPath, output, 'utf8');
			this.parsedDigest = digestOf(output);
			this.dirty = false;
		}

		if (this.checksumsLoaded && this.checksums.size > 0) {
			const lines = [...this.checksums.entries()]
				.toSorted(([a], [b]) => a.localeCompare(b))
				.map(([key, digest]) => `${key}=${digest}`);
			await writeFile(
				join(this.path, 'Files', 'Data', 'docs.checksum'),
				`${lines.join('\n')}\n`,
				'utf8'
			);
		}
		return true;
	}

	/** Re-read from disk, dropping anything staged. */
	async reload(): Promise<void> {
		const raw = await readFile(this.scrivxPath, 'utf8');
		this.tree = stripLayoutWhitespace(parseXml(raw));
		this.parsedDigest = digestOf(raw);
		this.dirty = false;
		this.checksums.clear();
		this.checksumsLoaded = false;
	}

	markDirty(): void {
		this.dirty = true;
	}
}
