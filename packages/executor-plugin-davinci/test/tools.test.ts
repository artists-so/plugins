import { Effect } from '@executor-js/sdk/core';
import { describe, expect, test } from 'bun:test';
import { DavinciWorkflowEngine } from '../src/engine.js';
import { createDavinciPlugin } from '../src/server.js';
import { MemoryResolveBridge } from './fixture.js';

interface ToolLike {
	readonly name: string;
	readonly annotations?: {
		readonly requiresApproval?: boolean;
		readonly approvalDescription?: string;
	};
	readonly handler: (input: { args: unknown; ctx: unknown; elicit: unknown }) => unknown;
}

const fixtureTools = (): readonly ToolLike[] => {
	const plugin = createDavinciPlugin(new DavinciWorkflowEngine(new MemoryResolveBridge()));
	return (
		(plugin as unknown as () => {
			staticIntegrations: () => { tools: ToolLike[] }[];
		})().staticIntegrations()[0]?.tools ?? []
	);
};

const call = async (
	tools: readonly ToolLike[],
	name: string,
	args: unknown
): Promise<Record<string, unknown>> => {
	const target = tools.find((candidate) => candidate.name === name);
	if (target === undefined) throw new Error(`No tool named ${name}`);
	const answer = await Effect.runPromise(
		target.handler({ args, ctx: {}, elicit: undefined }) as Effect.Effect<unknown, unknown>
	);
	if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
		throw new Error(`Tool ${name} returned a non-object response`);
	}
	return answer as Record<string, unknown>;
};

describe('Executor tool surface', () => {
	test('registers five whole-job tools under davinci_native', () => {
		const tools = fixtureTools();
		expect(tools.map((entry) => entry.name).toSorted()).toEqual([
			'bins_sync',
			'project_setup',
			'resolve_probe',
			'selects_build',
			'source_catalog_plan',
		]);
	});

	test('all mutating tools carry Executor approval annotations', () => {
		const tools = fixtureTools();
		for (const name of ['project_setup', 'bins_sync', 'selects_build']) {
			const target = tools.find((candidate) => candidate.name === name);
			expect(target?.annotations?.requiresApproval).toBe(true);
			expect(target?.annotations?.approvalDescription).toBeTruthy();
		}
		for (const name of ['resolve_probe', 'source_catalog_plan']) {
			const target = tools.find((candidate) => candidate.name === name);
			expect(target?.annotations?.requiresApproval).not.toBe(true);
		}
	});

	test('an actionable catalog refusal is delivered as data', async () => {
		const response = await call(fixtureTools(), 'source_catalog_plan', {
			sourceRoot: 'relative/media',
		});
		expect(response['refused']).toBe('invalid-plan');
		expect(String(response['message'])).toContain('absolute');
	});

	test('apply without a dry-run token is delivered as data', async () => {
		const response = await call(fixtureTools(), 'project_setup', {
			projectName: 'Fixture Project',
			settings: { timelineFrameRate: '24' },
			dryRun: false,
		});
		expect(response['refused']).toBe('plan-required');
		expect(response['plan']).toBeUndefined();
	});

	test('dry run returns the complete reviewed plan and a token', async () => {
		const response = await call(fixtureTools(), 'project_setup', {
			projectName: 'Fixture Project',
			settings: { timelineFrameRate: '24' },
			binPaths: ['01 Sources'],
			dryRun: true,
		});
		expect(response['dryRun']).toBe(true);
		expect(typeof response['planToken']).toBe('string');
		expect(response['plan']).toBeDefined();
	});
});
