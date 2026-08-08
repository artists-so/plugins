/**
 * What parsing a project costs, and what asking about it costs afterwards.
 *
 *   bun run bench                                  against the test fixture
 *   SCRIV_PROJECT=/path/to/Novel.scriv bun run bench    against your own
 *
 * This measures the plugin's own work, with no daemon involved, which is the
 * part that differs between an integration inside the agent's runtime and one
 * spawned per call. A spawned server pays the parse column on *every* call,
 * because nothing survives; in-process it is paid once and the read column is
 * what a working session actually costs.
 *
 * Your project is only read, never written.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ScrivenerProject } from '../src/project.js';
import { binderReadResult } from '../src/views.js';
import { createFixtureProject } from '../test/fixture.js';

const RUNS = 20;

const workspace = await mkdtemp(join(tmpdir(), 'scriv-bench-'));
const supplied = process.env['SCRIV_PROJECT'];
const path = supplied ?? (await createFixtureProject(workspace));

const median = (samples: number[]): number =>
	samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;

const time = async (runs: number, body: () => Promise<unknown> | unknown): Promise<number[]> => {
	const samples: number[] = [];
	for (let run = 0; run < runs; run += 1) {
		const started = performance.now();
		await body();
		samples.push(performance.now() - started);
	}
	return samples;
};

// Discard the first of each: the filesystem cache and the JIT both settle.
await ScrivenerProject.open(path);
const parses = await time(RUNS, () => ScrivenerProject.open(path));

const cached = await ScrivenerProject.open(path);
binderReadResult(cached, { as: 'text' });
const reads = await time(RUNS, () => binderReadResult(cached, { as: 'text' }));

const items = (JSON.stringify(binderReadResult(cached)).match(/"id":/g) ?? []).length;
const ms = (value: number): string => `${value.toFixed(1)} ms`;

console.log(`project: ${path}${supplied === undefined ? ' (synthetic fixture)' : ''}`);
console.log(`binder items: ${items}, runs: ${RUNS}, medians\n`);
console.log(`parse the project from disk   ${ms(median(parses))}`);
console.log(`read the binder, once parsed  ${ms(median(reads))}`);
console.log(
	`\nA spawned server pays both on every call. In-process, the first column is` +
		`\npaid once per daemon lifetime.`
);

await rm(workspace, { recursive: true, force: true });
