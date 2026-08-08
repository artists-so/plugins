/**
 * Engine tests against a Scrivener project on disk.
 *
 * By default the project is a synthetic fixture (test/fixture.ts) shaped like
 * real Scrivener 3.5.2 output, so the suite runs anywhere, including CI. Set
 * SCRIV_TEST_PROJECT to a .scriv path to run the same suite against a real
 * project instead — only a temporary copy is ever touched.
 *
 * The project is copied per run, because the failures worth catching here are
 * corruption failures: a write that succeeds, leaves valid XML, and quietly
 * destroys the label definitions or moves a synopsis somewhere Scrivener does
 * not look. Those cannot be seen by inspecting the return value of the call that
 * caused them, so each test reads the files back instead. A real project used
 * this way must define DAWN and DAY labels and PLANNED and DRAFTED statuses.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeHazard } from '../src/guard.js';
import { ScrivenerProject } from '../src/project.js';
import { reconcile, type OutlineNode } from '../src/reconcile.js';
import { rtfToText, textToRtf } from '../src/rtf.js';
import { createFixtureProject } from './fixture.js';

let workspace: string;
let projectPath: string;

beforeAll(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'scriv-test-'));
	const source = process.env['SCRIV_TEST_PROJECT'];
	if (source === undefined) {
		projectPath = await createFixtureProject(workspace);
	} else {
		projectPath = join(workspace, 'test.scriv');
		await cp(source, projectPath, { recursive: true });
	}
});

afterAll(async () => {
	await rm(workspace, { recursive: true, force: true });
});

const scrivxOf = async (): Promise<string> => {
	const entries = await readdir(projectPath);
	const scrivx = entries.find((entry) => entry.endsWith('.scrivx'));
	if (scrivx === undefined) throw new Error('No .scrivx in the test project');
	return readFile(join(projectPath, scrivx), 'utf8');
};

test('reads the label and status vocabularies', async () => {
	const project = await ScrivenerProject.open(projectPath);
	const labels = project.labels().map((entry) => entry.title);
	const statuses = project.statuses().map((entry) => entry.title);

	expect(labels).toContain('DAWN');
	expect(labels).toContain('DAY');
	expect(statuses).toContain('DRAFTED');
	// Ids must be the numbers items reference, not titles.
	expect(project.labels().find((l) => l.title === 'DAWN')?.id).toMatch(/^\d+$/);
});

test('reads the manuscript tree', async () => {
	const project = await ScrivenerProject.open(projectPath);
	const tree = project.read(project.resolveRoot('manuscript'));
	expect(tree.length).toBeGreaterThan(0);
	const acts = tree[0]?.children ?? [];
	expect(acts.length).toBeGreaterThan(0);
});

const countOf = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

test('a save with no edits preserves attributes and definitions', async () => {
	const before = await scrivxOf();
	const project = await ScrivenerProject.open(projectPath);
	project.markDirty();
	await project.save();
	const after = await scrivxOf();

	// The exact serialisation may differ; what must not change is the load-bearing
	// content. This is the shape of the bug that corrupted the real project.
	expect(countOf(after, /<BinderItem UUID="/g)).toBe(countOf(before, /<BinderItem UUID="/g));
	expect(countOf(after, /<Label ID="/g)).toBe(countOf(before, /<Label ID="/g));
	expect(countOf(after, /<Status ID="/g)).toBe(countOf(before, /<Status ID="/g));
	// Attributes must never have become child elements.
	expect(after).not.toMatch(/<Label>\s*<ID>/);
	expect(after).not.toMatch(/<BinderItem>\s*<UUID>/);
});

test('repeated saves do not grow the file', async () => {
	const project = await ScrivenerProject.open(projectPath);
	project.markDirty();
	await project.save();
	const first = (await scrivxOf()).length;

	const again = await ScrivenerProject.open(projectPath);
	again.markDirty();
	await again.save();
	const second = (await scrivxOf()).length;

	// Whitespace re-parsed as content is what makes a formatter compound.
	expect(Math.abs(second - first)).toBeLessThan(64);
});

const OUTLINE: OutlineNode[] = [
	{
		title: 'Test act',
		type: 'Folder',
		synopsis: 'An act added by the test.',
		children: [
			{
				title: 'Test scene',
				type: 'Text',
				label: 'DAWN',
				status: 'DRAFTED',
				synopsis: 'A scene with an index card.',
				notes: 'Notes for the scene.',
				content: 'The first line.\n\nThe second line, after a break.',
			},
		],
	},
];

test('sync creates, labels, and writes the files Scrivener reads', async () => {
	const project = await ScrivenerProject.open(projectPath);
	const result = await reconcile(project, OUTLINE, { root: 'manuscript' });

	expect(result.changes.filter((c) => c.action === 'created').length).toBe(2);

	const tree = project.read(project.resolveRoot('manuscript'));
	const act = (tree[0]?.children ?? []).find((child) => child.title === 'Test act');
	expect(act).toBeDefined();
	const scene = act?.children?.[0];
	expect(scene?.title).toBe('Test scene');
	// Resolved back to names proves the numeric ids were written correctly.
	expect(scene?.label).toBe('DAWN');
	expect(scene?.status).toBe('DRAFTED');

	const id = scene?.id ?? '';
	expect(await project.readSynopsis(id)).toBe('A scene with an index card.');
	expect(await project.readText(id)).toContain('The second line, after a break.');

	// The synopsis must be a file, not an XML element, or Scrivener shows nothing.
	const raw = await readFile(join(projectPath, 'Files', 'Data', id, 'synopsis.txt'), 'utf8');
	expect(raw).toBe('A scene with an index card.');
	const scrivx = await scrivxOf();
	expect(scrivx).not.toMatch(/<Synopsis>/);

	// The item must reference a numeric label id.
	expect(scrivx).toMatch(/<LabelID>\d+<\/LabelID>/);
});

test('the same outline run twice changes nothing — not even field updates', async () => {
	const project = await ScrivenerProject.open(projectPath);
	const result = await reconcile(project, OUTLINE, { root: 'manuscript' });
	expect(result.changes.filter((c) => c.action === 'created').length).toBe(0);
	expect(result.changes.filter((c) => c.action === 'reordered').length).toBe(0);
	// Synopsis, notes and content are compared against disk before staging, so
	// an unchanged outline is a true no-op, not a full rewrite that happens to
	// produce the same bytes.
	expect(result.changes.filter((c) => c.action === 'updated')).toEqual([]);
	expect(result.summary).toContain('0 updated');
});

test('a dry run writes nothing', async () => {
	const before = await scrivxOf();
	const project = await ScrivenerProject.open(projectPath);
	const result = await reconcile(
		project,
		[{ title: 'Never written', type: 'Folder', synopsis: 'x' }],
		{ root: 'manuscript', dryRun: true }
	);
	expect(result.summary).toContain('dry run');
	expect(result.changes.some((c) => c.action === 'created')).toBe(true);
	expect(await scrivxOf()).toBe(before);
});

test('an unknown label is refused, naming the valid ones', async () => {
	const project = await ScrivenerProject.open(projectPath);
	await expect(
		reconcile(project, [{ title: 'Bad label', label: 'NOT A LABEL' }], { root: 'manuscript' })
	).rejects.toThrow(/Unknown label/);
});

test('the checksum file records what was written', async () => {
	const project = await ScrivenerProject.open(projectPath);
	const tree = project.read(project.resolveRoot('manuscript'));
	const act = (tree[0]?.children ?? []).find((child) => child.title === 'Test act');
	const id = act?.children?.[0]?.id ?? '';

	const checksums = await readFile(join(projectPath, 'Files', 'Data', 'docs.checksum'), 'utf8');
	// Scrivener keys these by lowercased uuid.
	expect(checksums).toContain(`${id.toLowerCase()}/content.rtf=`);
	expect(checksums).toContain(`${id.toLowerCase()}/synopsis.txt=`);
});

test('rtf survives a round trip, including the characters that break it', async () => {
	const text = 'Braces {like this} and a backslash \\ and an em dash — plus 中文.\n\nSecond paragraph.';
	expect(rtfToText(textToRtf(text))).toBe(text);
});

test('runs of blank lines survive a round trip — ASCII diagrams depend on them', async () => {
	const text = 'THE LOGBOOK\n\n\n   MORNING     DAY\n\n\n\nafter the table.';
	expect(rtfToText(textToRtf(text))).toBe(text);
});

// ---------------------------------------------------------------------------
// External-writer protection — the Scrivener-had-it-open failure, reproduced.
// ---------------------------------------------------------------------------

const touchScrivx = async (): Promise<void> => {
	const entries = await readdir(projectPath);
	const scrivx = entries.find((entry) => entry.endsWith('.scrivx'));
	const file = join(projectPath, scrivx ?? '');
	// Append a comment: content changes, validity preserved — like an external save.
	await writeFile(file, `${await readFile(file, 'utf8')}<!-- external -->`, 'utf8');
};

test('a save refuses to overwrite an external change, and nothing is written', async () => {
	const project = await ScrivenerProject.open(projectPath);
	await touchScrivx();
	const before = await scrivxOf();

	project.markDirty();
	expect(project.save()).rejects.toThrow(/changed on disk/);
	expect(await scrivxOf()).toBe(before);
});

test('changedOnDisk reports drift, reload clears it, saving then works', async () => {
	const project = await ScrivenerProject.open(projectPath);
	await touchScrivx();
	expect(await project.changedOnDisk()).toBe(true);

	await project.reload();
	expect(await project.changedOnDisk()).toBe(false);

	project.markDirty();
	expect(await project.save()).toBe(true);
	// Its own save must not count as external drift.
	expect(await project.changedOnDisk()).toBe(false);
});

test('a user.lock in the package is reported as a write hazard', async () => {
	const lock = join(projectPath, 'Files', 'user.lock');
	await writeFile(lock, 'machine: elsewhere\n', 'utf8');
	const hazard = await writeHazard(projectPath, { checkProcess: false });
	expect(hazard).toMatch(/user\.lock/);

	await rm(lock);
	expect(await writeHazard(projectPath, { checkProcess: false })).toBeUndefined();
});

test('reads the rtf Scrivener itself wrote', async () => {
	// The template's front matter is real Scrivener output, with a font table,
	// tab stops and a hex-escaped copyright sign.
	const project = await ScrivenerProject.open(projectPath);
	const all = project.read(project.resolveRoot('binder'));
	const flat: { id: string; title: string; children?: unknown }[] = [];
	const walk = (nodes: typeof all): void => {
		for (const node of nodes) {
			flat.push(node);
			if (node.children) walk(node.children);
		}
	};
	walk(all);

	let sawText = false;
	for (const node of flat) {
		const text = await project.readText(node.id);
		if (text.includes('All rights reserved')) {
			sawText = true;
			// The font table must not have leaked into the prose.
			expect(text).not.toContain('fonttbl');
			expect(text).not.toContain('Palatino');
			expect(text).toContain('©');
		}
	}
	expect(sawText).toBe(true);
});
