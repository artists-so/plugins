/**
 * Executor integration plugin for Scrivener projects.
 *
 * Registered from a scope's executor.jsonc, so its tools run inside the Executor
 * runtime rather than in a spawned MCP server. That removes the cost which
 * dominates Scrivener work over stdio — a process per tool call, each one
 * re-reading and re-parsing the whole project before it can do anything — and it
 * is what makes the project cache below worth having.
 *
 * The surface is four tools rather than one wrapper per feature. An agent asked
 * to restructure a manuscript through a fine-grained API makes a hundred round
 * trips to do one job, and every one of them is a chance to leave the project
 * half-edited; `binder_sync` takes the whole intended shape in a single call and
 * either applies it or does not.
 *
 * Effect comes from @executor-js/sdk/core rather than from `effect` directly, so
 * the plugin shares the SDK's copy instead of carrying a second one.
 *
 * Each `execute` takes `unknown` and parses its own arguments. The SDK types
 * `execute` to receive the schema's inferred output, but that inference does not
 * survive to this package and the argument silently arrives as `any` instead —
 * which is worth refusing, since these tools write to a manuscript. Parsing here
 * restores real types and stops trusting that validation happened upstream.
 *
 * Tool bodies are plain async functions inside `answering`, which is where the
 * failure policy lives: an expected refusal is returned as data so the caller
 * can read the reason, and anything else fails and becomes a logged fault. See
 * `refusal.ts` for why that distinction has to exist.
 */

import { definePlugin, Effect, tool } from '@executor-js/sdk/core';
import { z } from 'zod';
import { writeHazard } from './guard.js';
import { ScrivenerProject } from './project.js';
import { reconcile, type OutlineNode } from './reconcile.js';
import { isRefusal, Refusal, refusalPayload, type RefusalPayload } from './refusal.js';

import { binderReadResult } from './views.js';

/**
 * Run a tool body, delivering refusals as data and letting faults fail.
 *
 * Argument-shape errors are not handled here: the runtime validates
 * `inputSchema` before the handler runs and returns the offending issues to the
 * caller intact (verified 2026-08-09), so they are already legible.
 */
const answering = <A>(body: () => Promise<A>): Effect.Effect<A | RefusalPayload, Error> =>
	Effect.tryPromise({
		try: async () => {
			try {
				return await body();
			} catch (error) {
				if (isRefusal(error)) return refusalPayload(error);
				throw error;
			}
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});

/**
 * One parsed project per path, for the life of the process.
 *
 * The cache is self-healing: every load compares the digest of the .scrivx on
 * disk with the digest this instance parsed, and re-reads transparently when
 * they differ — so edits made in Scrivener (or by a sync client) are picked up
 * without anyone remembering a reload flag, while the unchanged case stays at
 * in-process speed. The engine additionally refuses to save over bytes it has
 * not seen, so even a mid-call external write cannot be destroyed.
 */
const open = new Map<string, ScrivenerProject>();

async function load(path: string, reload = false): Promise<ScrivenerProject> {
	const cached = open.get(path);
	if (cached !== undefined) {
		if ((await cached.changedOnDisk()) || reload) {
			if (cached.isDirty() && !reload) {
				throw new Refusal(
					'changed-on-disk',
					`${path} changed on disk while edits were staged in memory. Refusing to guess which should win; nothing was written. Re-run the operation — it will start from the current file.`
				);
			}
			await cached.reload();
		}
		return cached;
	}
	const project = await ScrivenerProject.open(path);
	open.set(path, project);
	return project;
}

/** Refuse writes while Scrivener plausibly has the project open, unless forced. */
async function guardWrite(path: string, force: boolean | undefined): Promise<void> {
	if (force === true) return;
	const hazard = await writeHazard(path);
	if (hazard !== undefined) throw new Refusal('scrivener-open', hazard);
}

const projectPath = z.string().describe('Absolute path to the .scriv package');
const rootArg = z
	.string()
	.optional()
	.describe('"manuscript" (default), "binder", or a binder item id');

/** Recursive by getter, which is how Zod 4 expresses a self-referencing object. */
const outlineNode = z.object({
	title: z.string().describe('Item title, and how it is matched against the binder'),
	type: z.enum(['Folder', 'Text']).optional().describe('Defaults to Folder if it has children'),
	id: z.string().optional().describe('Match this existing item by id, so it can be retitled'),
	label: z.string().optional().describe('Label name, as defined in the project'),
	status: z.string().optional().describe('Status name, as defined in the project'),
	synopsis: z.string().optional().describe('Index card text'),
	notes: z.string().optional().describe('Document notes'),
	content: z.string().optional().describe('Document text, as plain text'),
	keywords: z.array(z.string()).optional(),
	includeInCompile: z.boolean().optional(),
	get children(): z.ZodOptional<z.ZodArray<typeof outlineNode>> {
		return z.array(outlineNode).optional();
	},
});

const binderReadArgs = z.object({
	path: projectPath,
	root: rootArg,
	reload: z
		.boolean()
		.optional()
		.describe('Re-read from disk first, if the project was edited in Scrivener'),
	as: z
		.enum(['tree', 'text'])
		.optional()
		.describe('"tree" (default) for structured data, "text" for an indented outline'),
});

const forceArg = z
	.boolean()
	.optional()
	.describe(
		'Write even though Scrivener appears to be open. Only safe when you know the open project is a different one — a project open in Scrivener will silently overwrite these changes on its next auto-save.'
	);

const binderSyncArgs = z.object({
	path: projectPath,
	outline: z.array(outlineNode).describe('The intended shape of the tree under root'),
	root: rootArg,
	prune: z
		.boolean()
		.optional()
		.describe('Delete items under root that the outline does not mention'),
	dryRun: z
		.boolean()
		.optional()
		.describe('Report the plan without writing anything (default false)'),
	force: forceArg,
});

const documentReadArgs = z.object({
	path: projectPath,
	id: z.string().describe('Binder item id (UUID)'),
});

const documentWriteArgs = z.object({
	path: projectPath,
	id: z.string().describe('Binder item id (UUID)'),
	content: z.string().optional().describe('Document text, as plain text'),
	synopsis: z.string().optional().describe('Index card text'),
	notes: z.string().optional().describe('Document notes'),
	label: z.string().optional().describe('Label name, as defined in the project'),
	status: z.string().optional().describe('Status name, as defined in the project'),
	force: forceArg,
});

export const scrivenerPlugin = definePlugin(() => ({
	id: 'scrivener_native' as const,
	packageName: '@artists-so/executor-plugin-scrivener',

	storage: () => ({}),

	staticIntegrations: () => [
		{
			id: 'scrivener_native',
			kind: 'scrivener_native',
			name: 'Scrivener (native)',
			canRemove: false,
			canRefresh: false,
			canEdit: false,
			tools: [
				tool({
					name: 'binder_read',
					description:
						'Read a Scrivener project: the binder tree, with labels and statuses resolved to their names, plus the label and status vocabularies the project defines. Call this before writing, to learn which label and status names are valid — binder_sync rejects names the project does not define.',
					inputSchema: binderReadArgs,
					annotations: { readOnlyHint: true },
					execute: (raw: unknown) =>
						answering(async () => {
							const args = binderReadArgs.parse(raw);
							const project = await load(args.path, args.reload === true);
							return binderReadResult(project, { root: args.root, as: args.as });
						}),
				}),

				tool({
					name: 'binder_sync',
					description:
						'Make a project match a declared outline in one pass: creates missing items, retitles, reorders, and sets label, status, synopsis, notes and document text. Items are matched by title within their parent, so running the same outline twice changes nothing the second time, and an outline can be reordered freely without losing documents. Nothing is deleted unless prune is set. Run with dryRun first to see the plan.',
					inputSchema: binderSyncArgs,
					execute: (raw: unknown) =>
						answering(async () => {
							const args = binderSyncArgs.parse(raw);
							if (args.dryRun !== true) await guardWrite(args.path, args.force);
							const project = await load(args.path);
							return reconcile(project, args.outline as OutlineNode[], {
								...(args.root === undefined ? {} : { root: args.root }),
								...(args.prune === undefined ? {} : { prune: args.prune }),
								...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
							});
						}),
				}),

				tool({
					name: 'document_read',
					description:
						"Read one document: its text, converted from RTF to plain text, and its synopsis. Use binder_read first to find the document's id.",
					inputSchema: documentReadArgs,
					annotations: { readOnlyHint: true },
					execute: (raw: unknown) =>
						answering(async () => {
							const args = documentReadArgs.parse(raw);
							const project = await load(args.path);
							// Resolving the id first turns "no such document" into a refusal
							// rather than an empty-looking success.
							project.resolveRoot(args.id);
							const [text, synopsis] = await Promise.all([
								project.readText(args.id),
								project.readSynopsis(args.id),
							]);
							return {
								id: args.id,
								text,
								synopsis,
								words: text.split(/\s+/).filter(Boolean).length,
							};
						}),
				}),

				tool({
					name: 'document_write',
					description:
						'Write one existing document in place: its text, synopsis, notes, label or status. For anything structural, or for more than a couple of documents, use binder_sync instead.',
					inputSchema: documentWriteArgs,
					execute: (raw: unknown) =>
						answering(async () => {
							const args = documentWriteArgs.parse(raw);
							await guardWrite(args.path, args.force);
							const project = await load(args.path);
							const { path: _path, id, force: _force, ...fields } = args;
							const item = project.resolveRoot(id);
							const metadata =
								fields.label === undefined && fields.status === undefined
									? []
									: project.applyMetadata(item, fields);
							const files = await project.writeFields(id, fields);
							await project.save();
							return { id, written: [...files, ...metadata] };
						}),
				}),
			],
		},
	],
}));

export default scrivenerPlugin;
