import type { BridgeAction, ResolveBridgeClient } from '../src/bridge.js';
import { z } from 'zod';

const projectSpec = z.object({
	projectName: z.string(),
	mediaLocationPath: z.string().optional(),
	settings: z.record(z.string(), z.string()),
	binPaths: z.array(z.string()),
});

const binsSpec = z.object({
	projectName: z.string(),
	bins: z.array(
		z.object({
			path: z.string(),
			sources: z.array(z.string()),
		})
	),
});

const selectsSpec = z.object({
	projectName: z.string(),
	timelineName: z.string(),
	fingerprint: z.string(),
	clips: z.array(
		z.object({
			sourcePath: z.string(),
			startFrame: z.number(),
			endFrame: z.number(),
			includeAudio: z.boolean(),
		})
	),
});

interface FixtureTimeline {
	readonly fingerprint: string;
	readonly clips: readonly {
		readonly sourcePath: string;
		readonly startFrame: number;
		readonly endFrame: number;
	}[];
}

const refusal = (refused: string, message: string, details?: unknown): unknown => ({
	refused,
	message,
	...(details === undefined ? {} : { details }),
});

export class MemoryResolveBridge implements ResolveBridgeClient {
	readonly calls: BridgeAction[] = [];
	projectName: string | undefined;
	readonly settings = new Map<string, string>();
	readonly bins = new Set<string>();
	readonly sources = new Map<string, string>();
	readonly timelines = new Map<string, FixtureTimeline>();

	async call(
		action: BridgeAction,
		payload: Readonly<Record<string, unknown>>
	): Promise<unknown> {
		this.calls.push(action);
		switch (action) {
			case 'probe':
				return {
					connected: true,
					product: 'DaVinci Resolve Studio',
					version: '21.0.4.0006',
					versionFields: [21, 0, 4, 6, ''],
					currentProject: this.projectName ?? null,
					currentPage: 'media',
					apiModulePath: '/fixture/DaVinciResolveScript.py',
					pythonVersion: '3.12.0',
					capabilities: {
						projectSetup: true,
						mediaPoolFolders: true,
						mediaImport: true,
						timelineCreate: true,
						timelineAppend: true,
						timelineReadback: true,
						intelliSearch: true,
					},
					message: 'Connected to fixture Resolve.',
				};
			case 'project_setup_plan':
				return this.projectPlan(projectSpec.parse(payload));
			case 'project_setup_apply':
				return this.projectApply(projectSpec.parse(payload));
			case 'bins_sync_plan':
				return this.binsPlan(binsSpec.parse(payload));
			case 'bins_sync_apply':
				return this.binsApply(binsSpec.parse(payload));
			case 'selects_build_plan':
				return this.selectsPlan(selectsSpec.parse(payload));
			case 'selects_build_apply':
				return this.selectsApply(selectsSpec.parse(payload));
		}
	}

	async close(): Promise<void> {}

	private projectPlan(spec: z.infer<typeof projectSpec>): unknown {
		if (this.projectName !== undefined && this.projectName !== spec.projectName) {
			return refusal(
				'project-not-current',
				`Fixture project ${spec.projectName} is not current.`
			);
		}
		const actions: unknown[] = [];
		if (this.projectName === undefined) {
			actions.push({ kind: 'create-project', projectName: spec.projectName });
		}
		for (const [key, value] of Object.entries(spec.settings)) {
			const observed = this.settings.get(key);
			if (observed !== value) {
				actions.push({
					kind: 'set-setting',
					key,
					from: observed ?? null,
					to: value,
				});
			}
		}
		for (const path of spec.binPaths) {
			const parts = path.split('/');
			for (let index = 1; index <= parts.length; index++) {
				const prefix = parts.slice(0, index).join('/');
				if (!this.bins.has(prefix) && !actions.some(isCreateBin(prefix))) {
					actions.push({ kind: 'create-bin', path: prefix });
				}
			}
		}
		return {
			operation: 'project-setup',
			projectName: spec.projectName,
			actions,
			readback: {
				exists: this.projectName === spec.projectName,
				currentProject: this.projectName ?? null,
				settings: Object.fromEntries(
					Object.keys(spec.settings).map((key) => [key, this.settings.get(key) ?? ''])
				),
				bins: [...this.bins].toSorted(),
			},
		};
	}

	private projectApply(spec: z.infer<typeof projectSpec>): unknown {
		const before = this.projectPlan(spec);
		if (isFixtureRefusal(before)) return before;
		const actions = planActions(before);
		for (const action of actions) {
			if (action.kind === 'create-project') this.projectName = spec.projectName;
			if (action.kind === 'set-setting') this.settings.set(action.key, action.to);
			if (action.kind === 'create-bin') this.bins.add(action.path);
		}
		return this.writeResult('project-setup', actions.length > 0, this.projectPlan(spec));
	}

	private binsPlan(spec: z.infer<typeof binsSpec>): unknown {
		const current = this.requireProject(spec.projectName);
		if (current !== undefined) return current;
		const actions: unknown[] = [];
		const alreadyPresent: { sourcePath: string; binPath: string }[] = [];
		for (const bin of spec.bins) {
			const parts = bin.path.split('/');
			for (let index = 1; index <= parts.length; index++) {
				const prefix = parts.slice(0, index).join('/');
				if (!this.bins.has(prefix) && !actions.some(isCreateBin(prefix))) {
					actions.push({ kind: 'create-bin', path: prefix });
				}
			}
			for (const sourcePath of bin.sources) {
				const currentBin = this.sources.get(sourcePath);
				if (currentBin !== undefined && currentBin !== bin.path) {
					return refusal(
						'source-already-imported-elsewhere',
						`${sourcePath} is already in ${currentBin}.`
					);
				}
				if (currentBin === bin.path) {
					alreadyPresent.push({ sourcePath, binPath: bin.path });
				} else {
					actions.push({ kind: 'import-source', sourcePath, binPath: bin.path });
				}
			}
		}
		return {
			operation: 'bins-sync',
			projectName: spec.projectName,
			actions,
			alreadyPresent,
		};
	}

	private binsApply(spec: z.infer<typeof binsSpec>): unknown {
		const before = this.binsPlan(spec);
		if (isFixtureRefusal(before)) return before;
		const actions = planActions(before);
		for (const action of actions) {
			if (action.kind === 'create-bin') this.bins.add(action.path);
			if (action.kind === 'import-source') {
				this.sources.set(action.sourcePath, action.binPath);
			}
		}
		return this.writeResult('bins-sync', actions.length > 0, this.binsPlan(spec));
	}

	private selectsPlan(spec: z.infer<typeof selectsSpec>): unknown {
		const current = this.requireProject(spec.projectName);
		if (current !== undefined) return current;
		for (const clip of spec.clips) {
			if (!this.sources.has(clip.sourcePath)) {
				return refusal('source-missing', `${clip.sourcePath} is not imported.`);
			}
		}
		const desired = spec.clips.map(({ sourcePath, startFrame, endFrame }) => ({
			sourcePath,
			startFrame,
			endFrame,
		}));
		const existing = this.timelines.get(spec.timelineName);
		if (
			existing !== undefined &&
			(existing.fingerprint !== spec.fingerprint ||
				JSON.stringify(existing.clips) !== JSON.stringify(desired))
		) {
			return refusal('timeline-conflict', `${spec.timelineName} already differs.`);
		}
		return {
			operation: 'selects-build',
			projectName: spec.projectName,
			timelineName: spec.timelineName,
			status: existing === undefined ? 'create' : 'up-to-date',
			fingerprint: spec.fingerprint,
			clips: desired,
		};
	}

	private selectsApply(spec: z.infer<typeof selectsSpec>): unknown {
		const before = this.selectsPlan(spec);
		if (isFixtureRefusal(before)) return before;
		const plan = selectsPlanValue(before);
		if (plan.status === 'create') {
			this.timelines.set(spec.timelineName, {
				fingerprint: spec.fingerprint,
				clips: plan.clips,
			});
		}
		return this.writeResult('selects-build', plan.status === 'create', this.selectsPlan(spec));
	}

	private requireProject(expected: string): unknown | undefined {
		if (this.projectName === undefined) {
			return refusal('project-missing', 'No fixture project is current.');
		}
		if (this.projectName !== expected) {
			return refusal('project-not-current', `${expected} is not current.`);
		}
		return undefined;
	}

	private writeResult(operation: string, changed: boolean, readback: unknown): unknown {
		return {
			operation,
			status: changed ? 'applied' : 'up-to-date',
			changed,
			verified: true,
			errors: [],
			readback,
		};
	}
}

interface FixtureAction {
	readonly kind: string;
	readonly path?: string;
	readonly key?: string;
	readonly to?: string;
	readonly sourcePath?: string;
	readonly binPath?: string;
}

const isFixtureRefusal = (value: unknown): value is { readonly refused: string } =>
	typeof value === 'object' &&
	value !== null &&
	'refused' in value &&
	typeof value.refused === 'string';

const planActions = (value: unknown): readonly FixtureAction[] => {
	if (typeof value !== 'object' || value === null || !('actions' in value)) return [];
	const actions = value.actions;
	return Array.isArray(actions) ? (actions as readonly FixtureAction[]) : [];
};

const isCreateBin =
	(path: string) =>
	(value: unknown): boolean =>
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		value.kind === 'create-bin' &&
		'path' in value &&
		value.path === path;

const selectsPlanValue = (
	value: unknown
): {
	readonly status: 'create' | 'up-to-date';
	readonly clips: readonly {
		readonly sourcePath: string;
		readonly startFrame: number;
		readonly endFrame: number;
	}[];
} => {
	const parsed = z
		.object({
			status: z.enum(['create', 'up-to-date']),
			clips: z.array(
				z.object({
					sourcePath: z.string(),
					startFrame: z.number(),
					endFrame: z.number(),
				})
			),
		})
		.parse(value);
	return parsed;
};
