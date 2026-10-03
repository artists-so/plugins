import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { DavinciWorkflowEngine } from '../src/engine.js';
import { Refusal } from '../src/refusal.js';
import { MemoryResolveBridge } from './fixture.js';

const ticket = z.object({
	dryRun: z.literal(true),
	planToken: z.string(),
	expiresAt: z.string(),
	plan: z.unknown(),
});

const result = z.object({
	dryRun: z.literal(false),
	status: z.enum(['applied', 'partial', 'up-to-date']),
	changed: z.boolean(),
	verified: z.boolean(),
	readback: z.unknown(),
});

const projectArgs = {
	projectName: 'Fixture Project',
	settings: { timelineFrameRate: '24' },
	binPaths: ['01 Sources/Camera A'],
};

async function createProject(
	engine: DavinciWorkflowEngine
): Promise<z.infer<typeof result>> {
	const planned = ticket.parse(await engine.projectSetup({ ...projectArgs, dryRun: true }));
	return result.parse(
		await engine.projectSetup({
			...projectArgs,
			dryRun: false,
			planToken: planned.planToken,
		})
	);
}

describe('DavinciWorkflowEngine', () => {
	test('probes the same persistent bridge', async () => {
		const bridge = new MemoryResolveBridge();
		const engine = new DavinciWorkflowEngine(bridge);
		const first = await engine.probe();
		const second = await engine.probe();
		expect(first.version).toStartWith('21.0.4');
		expect(first.capabilities.intelliSearch).toBe(true);
		expect(second.connected).toBe(true);
		expect(bridge.calls).toEqual(['probe', 'probe']);
	});

	test('project setup requires a reviewed dry run and is idempotent', async () => {
		const bridge = new MemoryResolveBridge();
		const engine = new DavinciWorkflowEngine(bridge);

		await expect(
			engine.projectSetup({ ...projectArgs, dryRun: false })
		).rejects.toMatchObject<Partial<Refusal>>({ code: 'plan-required' });

		const applied = await createProject(engine);
		expect(applied.status).toBe('applied');
		expect(applied.verified).toBe(true);
		expect(bridge.projectName).toBe('Fixture Project');
		expect(bridge.settings.get('timelineFrameRate')).toBe('24');
		expect(bridge.bins.has('01 Sources/Camera A')).toBe(true);

		const repeatPlan = ticket.parse(
			await engine.projectSetup({ ...projectArgs, dryRun: true })
		);
		const repeat = result.parse(
			await engine.projectSetup({
				...projectArgs,
				dryRun: false,
				planToken: repeatPlan.planToken,
			})
		);
		expect(repeat.status).toBe('up-to-date');
		expect(repeat.changed).toBe(false);
	});

	test('a plan is stale when Resolve changes after review', async () => {
		const bridge = new MemoryResolveBridge();
		const engine = new DavinciWorkflowEngine(bridge);
		await createProject(engine);

		const desired = { ...projectArgs, settings: { timelineFrameRate: '25' } };
		const planned = ticket.parse(await engine.projectSetup({ ...desired, dryRun: true }));
		bridge.settings.set('timelineFrameRate', '30');

		await expect(
			engine.projectSetup({
				...desired,
				dryRun: false,
				planToken: planned.planToken,
			})
		).rejects.toMatchObject<Partial<Refusal>>({ code: 'plan-stale' });
		expect(bridge.settings.get('timelineFrameRate')).toBe('30');
	});

	test('bins sync imports once and refuses to move an existing source', async () => {
		const bridge = new MemoryResolveBridge();
		const engine = new DavinciWorkflowEngine(bridge);
		await createProject(engine);
		const spec = {
			projectName: 'Fixture Project',
			bins: [{ path: '01 Sources/Camera A', sources: ['/media/A.mov'] }],
		};

		const planned = ticket.parse(await engine.binsSync({ ...spec, dryRun: true }));
		const applied = result.parse(
			await engine.binsSync({ ...spec, dryRun: false, planToken: planned.planToken })
		);
		expect(applied.verified).toBe(true);
		expect(bridge.sources.get('/media/A.mov')).toBe('01 Sources/Camera A');

		const repeatPlan = ticket.parse(await engine.binsSync({ ...spec, dryRun: true }));
		const repeat = result.parse(
			await engine.binsSync({
				...spec,
				dryRun: false,
				planToken: repeatPlan.planToken,
			})
		);
		expect(repeat.status).toBe('up-to-date');

		await expect(
			engine.binsSync({
				projectName: 'Fixture Project',
				bins: [{ path: '02 Other', sources: ['/media/A.mov'] }],
				dryRun: true,
			})
		).rejects.toMatchObject<Partial<Refusal>>({
			code: 'source-already-imported-elsewhere',
		});
	});

	test('selects construction creates only a matching variant', async () => {
		const bridge = new MemoryResolveBridge();
		const engine = new DavinciWorkflowEngine(bridge);
		await createProject(engine);
		bridge.sources.set('/media/A.mov', '01 Sources/Camera A');
		const spec = {
			projectName: 'Fixture Project',
			timelineName: 'Selects v01',
			clips: [
				{
					sourcePath: '/media/A.mov',
					startFrame: 100,
					endFrame: 148,
					includeAudio: true,
				},
			],
		};

		const planned = ticket.parse(await engine.selectsBuild({ ...spec, dryRun: true }));
		const applied = result.parse(
			await engine.selectsBuild({
				...spec,
				dryRun: false,
				planToken: planned.planToken,
			})
		);
		expect(applied.status).toBe('applied');
		expect(applied.verified).toBe(true);

		const repeatPlan = ticket.parse(await engine.selectsBuild({ ...spec, dryRun: true }));
		const repeat = result.parse(
			await engine.selectsBuild({
				...spec,
				dryRun: false,
				planToken: repeatPlan.planToken,
			})
		);
		expect(repeat.status).toBe('up-to-date');

		const current = bridge.timelines.get('Selects v01');
		if (current === undefined) throw new Error('Fixture timeline was not created');
		bridge.timelines.set('Selects v01', { ...current, fingerprint: 'someone-else' });
		await expect(
			engine.selectsBuild({ ...spec, dryRun: true })
		).rejects.toMatchObject<Partial<Refusal>>({ code: 'timeline-conflict' });
	});
});
