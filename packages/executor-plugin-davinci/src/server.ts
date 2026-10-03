/**
 * Native Executor surface for safe, whole-job DaVinci Resolve workflows.
 *
 * Domain behavior lives in engine/catalog modules. This file only declares the
 * agent-facing tools, validation, approval policy, and refusal delivery.
 */

import { definePlugin, Effect, tool } from '@executor-js/sdk/core';
import {
	binsSyncArgs,
	probeArgs,
	projectSetupArgs,
	selectsBuildArgs,
	sourceCatalogArgs,
} from './contracts.js';
import { buildSourceCatalog } from './catalog.js';
import { PersistentResolveBridge } from './bridge.js';
import { DavinciWorkflowEngine } from './engine.js';
import { isRefusal, refusalPayload, type RefusalPayload } from './refusal.js';

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

const defaultBridge = new PersistentResolveBridge();
const defaultWorkflow = new DavinciWorkflowEngine(defaultBridge);

export const createDavinciPlugin = (workflow: DavinciWorkflowEngine = defaultWorkflow) =>
	definePlugin(() => ({
		id: 'davinci_native' as const,
		packageName: '@artists-so/executor-plugin-davinci',

		storage: () => ({}),

		staticIntegrations: () => [
			{
				id: 'davinci_native',
				kind: 'davinci_native',
				name: 'DaVinci Resolve (native)',
				canRemove: false,
				canRefresh: false,
				canEdit: false,
				tools: [
					tool({
						name: 'resolve_probe',
						description:
							'Check the persistent bridge, official Resolve scripting module, running Resolve version, current project, and the exact workflow capabilities available. Call this first. It never creates or changes a project.',
						inputSchema: probeArgs,
						execute: (raw: unknown) =>
							answering(async () => {
								probeArgs.parse(raw);
								return workflow.probe();
							}),
					}),

					tool({
						name: 'source_catalog_plan',
						description:
							'Read a source directory and produce a deterministic catalog plus bins_sync input. It preserves relative folders, ignores hidden files and symlinks by default, and never imports, renames, or edits media. Use this before bins_sync.',
						inputSchema: sourceCatalogArgs,
						execute: (raw: unknown) =>
							answering(async () => buildSourceCatalog(sourceCatalogArgs.parse(raw))),
					}),

					tool({
						name: 'project_setup',
						description:
							'Declaratively create one new Resolve project or bring the current named project to requested settings and Media Pool bin paths. Existing projects are never switched automatically and nothing is overwritten or deleted. First call with dryRun: true; applying the returned planToken is approval-gated and every write is read back.',
						inputSchema: projectSetupArgs,
						annotations: {
							requiresApproval: true,
							approvalDescription:
								'Create or update the explicitly named current Resolve project, then verify settings and bins by readback.',
						},
						execute: (raw: unknown) =>
							answering(async () => workflow.projectSetup(projectSetupArgs.parse(raw))),
					}),

					tool({
						name: 'bins_sync',
						description:
							'Ensure declared Media Pool bins exist and import missing absolute source files into them. It is idempotent: matching clips are left alone; a source already elsewhere is refused rather than moved. It never deletes, moves, relinks, or renames. First call with dryRun: true, then apply its planToken.',
						inputSchema: binsSyncArgs,
						annotations: {
							requiresApproval: true,
							approvalDescription:
								'Create missing bins and import only the reviewed source files into the current named Resolve project.',
						},
						execute: (raw: unknown) =>
							answering(async () => workflow.binsSync(binsSyncArgs.parse(raw))),
					}),

					tool({
						name: 'selects_build',
						description:
							'Build a new selects timeline variant from explicit source frame ranges already in the Media Pool. A matching Artists-owned variant is a no-op; any unrelated or changed timeline with that name is refused and never replaced. No source timeline is edited. First call with dryRun: true, then apply its planToken.',
						inputSchema: selectsBuildArgs,
						annotations: {
							requiresApproval: true,
							approvalDescription:
								'Create the reviewed selects timeline variant and append the exact source frame ranges; never replace an existing timeline.',
						},
						execute: (raw: unknown) =>
							answering(async () => workflow.selectsBuild(selectsBuildArgs.parse(raw))),
					}),
				],
			},
		],

		close: () =>
			Effect.tryPromise({
				try: () => workflow.close(),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			}),
	}));

export const davinciPlugin = createDavinciPlugin();

export default davinciPlugin;
