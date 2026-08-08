/**
 * The tool contract, exercised through the real handlers.
 *
 * The engine tests cover behaviour; these cover delivery. A refusal that the
 * runtime turns into `Internal tool error [<id>]` is a refusal the agent cannot
 * read, which is the whole point of writing the sentence — so the shape of a
 * refusal is pinned here, at the boundary the runtime actually calls.
 */

import { Effect } from '@executor-js/sdk/core';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { scrivenerPlugin } from '../src/server.js';
import { createFixtureProject } from './fixture.js';

interface ToolLike {
	readonly name: string;
	readonly handler: (input: { args: unknown; ctx: unknown; elicit: unknown }) => unknown;
}

const tools = (
	(scrivenerPlugin as unknown as () => { staticIntegrations: () => { tools: ToolLike[] }[] })()
		.staticIntegrations()[0]?.tools ?? []
);

const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
	const target = tools.find((candidate) => candidate.name === name);
	if (target === undefined) throw new Error(`No tool named ${name}`);
	const result = await Effect.runPromise(
		target.handler({ args, ctx: {}, elicit: undefined }) as Effect.Effect<unknown, unknown>
	);
	return result as Record<string, unknown>;
};

let workspace: string;
let path: string;

beforeAll(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'scriv-tools-'));
	path = await createFixtureProject(workspace);
});

afterAll(async () => {
	await rm(workspace, { recursive: true, force: true });
});

test('the four tools are registered under scrivener_native', () => {
	expect(tools.map((entry) => entry.name).toSorted()).toEqual([
		'binder_read',
		'binder_sync',
		'document_read',
		'document_write',
	]);
});

test('binder_read answers with the vocabularies and the outline', async () => {
	const result = await call('binder_read', { path, as: 'text' });
	expect(result['labels']).toEqual(['No Track', 'DAWN', 'DAY']);
	expect(result['statuses']).toEqual(['No Status', 'PLANNED', 'DRAFTED']);
	expect(result['outline']).toContain('Manuscript');
});

test('a missing project is refused as data, not as a failure', async () => {
	const result = await call('binder_read', { path: join(workspace, 'Nope.scriv') });
	expect(result['refused']).toBe('project-unreadable');
	expect(String(result['message'])).toContain('Nope.scriv');
	// The failure channel would reach the caller as an opaque correlation id.
	expect(result['binder']).toBeUndefined();
});

test('an undefined label is refused with the names that are defined', async () => {
	const result = await call('binder_sync', {
		path,
		outline: [{ title: 'Bad', label: 'DUSK' }],
		dryRun: true,
	});
	expect(result['refused']).toBe('unknown-vocabulary');
	expect(String(result['message'])).toContain('DAWN');
	expect(result['summary']).toBeUndefined();
});

test('an unknown document id is refused rather than answered as empty', async () => {
	const result = await call('document_read', { path, id: 'not-a-real-uuid' });
	expect(result['refused']).toBe('item-missing');
	expect(result['text']).toBeUndefined();
});

test('a write applies once, then reports nothing left to do', async () => {
	// force skips the running-Scrivener check, which would otherwise refuse on a
	// developer machine with the app open — the fixture is not the open project.
	const outline = [{ title: 'Act I', type: 'Folder', synopsis: 'Written by the test.' }];
	const applied = await call('binder_sync', { path, outline, force: true });
	expect(applied['summary']).toContain('1 updated');

	const repeat = await call('binder_sync', { path, outline, force: true });
	expect(repeat['summary']).toContain('0 updated');
});

test('a dry run reports a plan and writes nothing', async () => {
	const result = await call('binder_sync', {
		path,
		outline: [{ title: 'Ghost act', type: 'Folder' }],
		dryRun: true,
	});
	expect(result['summary']).toContain('dry run');

	const after = await call('binder_read', { path, as: 'text' });
	expect(String(after['outline'])).not.toContain('Ghost act');
});
