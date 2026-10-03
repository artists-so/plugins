import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSourceCatalog } from '../src/catalog.js';
import { Refusal } from '../src/refusal.js';

const workspaces: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'davinci-catalog-'));
	workspaces.push(root);
	await mkdir(join(root, 'day-before', 'family'), { recursive: true });
	await mkdir(join(root, 'wedding-day', 'ceremony'), { recursive: true });
	await mkdir(join(root, '.hidden'), { recursive: true });
	await writeFile(join(root, 'day-before', 'family', 'clip-001.AVI'), 'first');
	await writeFile(join(root, 'wedding-day', 'ceremony', 'clip-002.mov'), 'second');
	await writeFile(join(root, 'wedding-day', 'ceremony', 'notes.txt'), 'ignored');
	await writeFile(join(root, '.hidden', 'clip-003.mov'), 'hidden');
	await symlink(
		join(root, 'day-before', 'family', 'clip-001.AVI'),
		join(root, 'linked.mov')
	);
	return root;
}

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('buildSourceCatalog', () => {
	test('preserves source folders as deterministic bin assignments', async () => {
		const root = await fixture();
		const catalog = await buildSourceCatalog({ sourceRoot: root });

		expect(catalog.summary.clips).toBe(2);
		expect(catalog.summary.bins).toBe(2);
		expect(catalog.summary.skippedSymlinks).toBe(1);
		expect(catalog.summary.extensions).toEqual({ avi: 1, mov: 1 });
		expect(catalog.bins.map((bin) => bin.path)).toEqual([
			'01 Sources/day-before/family',
			'01 Sources/wedding-day/ceremony',
		]);
		expect(catalog.clips.map((clip) => clip.relativePath)).toEqual([
			'day-before/family/clip-001.AVI',
			'wedding-day/ceremony/clip-002.mov',
		]);
	});

	test('can deliberately include hidden sources and narrow extensions', async () => {
		const root = await fixture();
		const catalog = await buildSourceCatalog({
			sourceRoot: root,
			binRoot: 'Sources',
			extensions: ['.mov'],
			includeHidden: true,
		});

		expect(catalog.summary.clips).toBe(2);
		expect(catalog.clips.map((clip) => clip.binPath)).toEqual([
			'Sources/.hidden',
			'Sources/wedding-day/ceremony',
		]);
	});

	test('refuses scans that cross the explicit safety ceiling', async () => {
		const root = await fixture();
		await expect(
			buildSourceCatalog({ sourceRoot: root, maxFiles: 1 })
		).rejects.toMatchObject<Partial<Refusal>>({ code: 'invalid-plan' });
	});
});
