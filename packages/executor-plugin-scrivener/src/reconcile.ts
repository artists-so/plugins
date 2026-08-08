/**
 * Reconcile a declared outline against the binder.
 *
 * The outline is the statement of intent and this makes the project match it, so
 * the same outline can be run repeatedly: the second run of an unchanged outline
 * changes nothing. That matters more than it sounds, because the alternative —
 * a script that creates things — cannot be run twice without either duplicating
 * the manuscript or being rewritten into a migration each time.
 *
 * Items are matched by title within their parent, not by position, so an outline
 * can be reordered freely and existing documents follow. Nothing is ever
 * deleted unless `prune` is asked for explicitly, and even then only inside the
 * part of the tree the outline covers.
 */

import type { ScrivenerProject, DocumentFields } from './project.js';
import { getAttr, setText, findChild, tagOf, type XmlNode } from './xml.js';

export interface OutlineNode extends DocumentFields {
	readonly title: string;
	readonly type?: 'Folder' | 'Text';
	/** Match an existing item by id, so it can be retitled rather than replaced. */
	readonly id?: string;
	readonly children?: OutlineNode[];
}

export interface Change {
	readonly action: 'created' | 'updated' | 'reordered' | 'pruned';
	readonly id: string;
	readonly title: string;
	readonly fields?: string[];
}

export interface ReconcileOptions {
	readonly root?: string;
	readonly prune?: boolean;
	readonly dryRun?: boolean;
}

export interface ReconcileResult {
	readonly summary: string;
	readonly changes: Change[];
}

const normalise = (title: string): string => title.trim().toLowerCase();

export async function reconcile(
	project: ScrivenerProject,
	outline: OutlineNode[],
	options: ReconcileOptions = {}
): Promise<ReconcileResult> {
	const changes: Change[] = [];
	// Applied only once the tree is settled, so a dry run touches no files.
	const fileWrites: { id: string; fields: DocumentFields }[] = [];

	const walk = async (parent: XmlNode, nodes: OutlineNode[]): Promise<void> => {
		const siblings = project.childItems(parent);
		const byTitle = new Map<string, XmlNode>();
		const byId = new Map<string, XmlNode>();
		for (const sibling of siblings) {
			if (tagOf(sibling) !== 'BinderItem') continue;
			byTitle.set(normalise(project.titleOf(sibling)), sibling);
			const id = getAttr(sibling, 'UUID');
			if (id !== undefined) byId.set(id, sibling);
		}

		const matched: XmlNode[] = [];

		for (const node of nodes) {
			const wantedType = node.type ?? (node.children?.length ? 'Folder' : 'Text');
			let item = node.id === undefined ? undefined : byId.get(node.id);
			let created = false;

			if (item === undefined) item = byTitle.get(normalise(node.title));

			if (item === undefined) {
				item = project.createItem(parent, node.title, wantedType);
				created = true;
			} else if (project.titleOf(item) !== node.title) {
				const title = findChild(item, 'Title');
				if (title !== undefined) {
					setText(title, node.title);
					project.markDirty();
				}
			}

			matched.push(item);
			const id = getAttr(item, 'UUID') ?? '';

			const metadataFields = project.applyMetadata(item, node);
			const fileFields: DocumentFields = {
				...(node.synopsis === undefined ? {} : { synopsis: node.synopsis }),
				...(node.notes === undefined ? {} : { notes: node.notes }),
				...(node.content === undefined ? {} : { content: node.content }),
			};
			const fileFieldNames = Object.keys(fileFields);
			if (fileFieldNames.length > 0) fileWrites.push({ id, fields: fileFields });

			const touched = [...metadataFields, ...fileFieldNames];
			if (created) {
				changes.push({ action: 'created', id, title: node.title, fields: touched });
			} else if (touched.length > 0) {
				changes.push({ action: 'updated', id, title: node.title, fields: touched });
			}

			if (node.children?.length) await walk(item, node.children);
		}

		// Put the declared items in the declared order, ahead of anything the
		// outline does not mention, which keeps hand-made items but stops them
		// interleaving with the manuscript.
		const declared = new Set(matched);
		const others = siblings.filter((s) => tagOf(s) === 'BinderItem' && !declared.has(s));
		const reordered = [...matched, ...(options.prune ? [] : others)];
		const orderChanged = reordered.some((item, index) => siblings[index] !== item);

		if (options.prune) {
			for (const victim of others) {
				changes.push({
					action: 'pruned',
					id: getAttr(victim, 'UUID') ?? '',
					title: project.titleOf(victim),
				});
			}
		}

		if (orderChanged || reordered.length !== siblings.length) {
			siblings.splice(0, siblings.length, ...reordered);
			project.markDirty();
			if (orderChanged) {
				changes.push({
					action: 'reordered',
					id: getAttr(parent, 'UUID') ?? 'root',
					title: project.titleOf(parent) || 'Binder',
				});
			}
		}
	};

	await walk(project.resolveRoot(options.root ?? 'manuscript'), outline);

	if (options.dryRun === true) {
		await project.reload();
	} else {
		for (const write of fileWrites) {
			if (write.id) await project.writeFields(write.id, write.fields);
		}
		await project.save();
	}

	const tally = (action: Change['action']): number =>
		changes.filter((change) => change.action === action).length;

	return {
		summary:
			`${tally('created')} created, ${tally('updated')} updated, ` +
			`${tally('reordered')} reordered, ${tally('pruned')} pruned` +
			(options.dryRun === true ? ' (dry run, nothing written)' : ''),
		changes,
	};
}

/** Flatten a binder view to one line per item, for a quick look at the shape. */
export function outlineText(
	nodes: { title: string; type: string; label?: string; status?: string; children?: unknown }[],
	depth = 0
): string[] {
	const lines: string[] = [];
	for (const node of nodes) {
		const marks = [node.label, node.status].filter((value) => value !== undefined).join(' · ');
		lines.push(`${'  '.repeat(depth)}${node.title}${marks ? `   [${marks}]` : ''}`);
		if (Array.isArray(node.children)) {
			lines.push(...outlineText(node.children as Parameters<typeof outlineText>[0], depth + 1));
		}
	}
	return lines;
}
