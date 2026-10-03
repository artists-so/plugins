import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
	binsPlanSchema,
	type BinsPlan,
	type BinsSyncArgs,
	probeResponseSchema,
	type ProbeResponse,
	projectPlanSchema,
	type ProjectPlan,
	type ProjectSetupArgs,
	refusalSchema,
	selectsPlanSchema,
	type SelectsBuildArgs,
	type SelectsPlan,
	writeResultSchema,
	type WriteResult,
} from './contracts.js';
import {
	BridgeProcessError,
	type BridgeAction,
	type ResolveBridgeClient,
} from './bridge.js';
import { Refusal, type RefusalCode } from './refusal.js';

type Operation = 'project-setup' | 'bins-sync' | 'selects-build';

interface PlanRecord {
	readonly operation: Operation;
	readonly digest: string;
	readonly expiresAt: number;
}

export interface PlanTicket {
	readonly planToken: string;
	readonly expiresAt: string;
}

const REFUSAL_CODES: readonly RefusalCode[] = [
	'resolve-unavailable',
	'project-not-current',
	'project-missing',
	'source-missing',
	'source-ambiguous',
	'source-already-imported-elsewhere',
	'timeline-conflict',
	'invalid-plan',
	'plan-required',
	'plan-stale',
];

const isRefusalCode = (value: string): value is RefusalCode =>
	REFUSAL_CODES.includes(value as RefusalCode);

const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonical(entry)])
	);
};

const digest = (value: unknown): string =>
	createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export class PlanGate {
	private readonly plans = new Map<string, PlanRecord>();

	constructor(
		private readonly ttlMs = 15 * 60 * 1_000,
		private readonly now: () => number = Date.now
	) {}

	issue(operation: Operation, spec: unknown, plan: unknown): PlanTicket {
		this.sweep();
		const planToken = randomUUID();
		const expiresAt = this.now() + this.ttlMs;
		this.plans.set(planToken, {
			operation,
			digest: digest({ operation, spec, plan }),
			expiresAt,
		});
		return { planToken, expiresAt: new Date(expiresAt).toISOString() };
	}

	verify(
		operation: Operation,
		token: string | undefined,
		spec: unknown,
		plan: unknown
	): void {
		if (token === undefined) {
			throw new Refusal(
				'plan-required',
				'Apply refused: run this same operation with dryRun: true first, then pass its planToken unchanged.'
			);
		}
		const record = this.plans.get(token);
		if (record === undefined || record.expiresAt <= this.now()) {
			this.plans.delete(token);
			throw new Refusal(
				'plan-stale',
				'The dry-run plan token is missing or expired. Run a fresh dry run; nothing was written.'
			);
		}
		const currentDigest = digest({ operation, spec, plan });
		if (record.operation !== operation || record.digest !== currentDigest) {
			throw new Refusal(
				'plan-stale',
				'Resolve or the requested specification changed after the dry run. Review a fresh plan; nothing was written.'
			);
		}
	}

	consume(token: string | undefined): void {
		if (token !== undefined) this.plans.delete(token);
	}

	private sweep(): void {
		const now = this.now();
		for (const [token, record] of this.plans) {
			if (record.expiresAt <= now) this.plans.delete(token);
		}
	}
}

const normalizeBinPath = (value: string): string => {
	const parts = value
		.replaceAll('\\', '/')
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
		throw new Refusal('invalid-plan', `Unsafe Media Pool bin path: ${value}`);
	}
	return parts.join('/');
};

const absolute = (value: string, label: string): string => {
	if (!isAbsolute(value)) {
		throw new Refusal('invalid-plan', `${label} must be an absolute path: ${value}`);
	}
	return resolve(value);
};

function bridgeValue<T>(value: unknown, schema: z.ZodType<T>): T {
	const refusal = refusalSchema.safeParse(value);
	if (refusal.success) {
		if (!isRefusalCode(refusal.data.refused)) {
			throw new Error(`Resolve bridge returned an unknown refusal code: ${refusal.data.refused}`);
		}
		throw new Refusal(
			refusal.data.refused,
			refusal.data.message,
			refusal.data.details
		);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Resolve bridge returned an invalid response: ${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}

const disconnectedProbe = (error: Error): ProbeResponse => ({
	connected: false,
	product: null,
	version: null,
	versionFields: [],
	currentProject: null,
	currentPage: null,
	apiModulePath: null,
	pythonVersion: 'unavailable',
	capabilities: {
		projectSetup: false,
		mediaPoolFolders: false,
		mediaImport: false,
		timelineCreate: false,
		timelineAppend: false,
		timelineReadback: false,
		intelliSearch: false,
	},
	message: error.message,
});

const projectSpec = (args: ProjectSetupArgs): Readonly<Record<string, unknown>> => ({
	projectName: args.projectName,
	...(args.mediaLocationPath === undefined
		? {}
		: { mediaLocationPath: absolute(args.mediaLocationPath, 'mediaLocationPath') }),
	settings: Object.fromEntries(
		Object.entries(args.settings ?? {}).toSorted(([left], [right]) =>
			left.localeCompare(right)
		)
	),
	binPaths: [...new Set((args.binPaths ?? []).map(normalizeBinPath))].toSorted(),
});

const binsSpec = (args: BinsSyncArgs): Readonly<Record<string, unknown>> => ({
	projectName: args.projectName,
	bins: args.bins
		.map((bin) => ({
			path: normalizeBinPath(bin.path),
			sources: [
				...new Set(bin.sources.map((source) => absolute(source, 'source'))),
			].toSorted(),
		}))
		.toSorted((left, right) => left.path.localeCompare(right.path)),
});

const selectsSpec = (args: SelectsBuildArgs): Readonly<Record<string, unknown>> => ({
	projectName: args.projectName,
	timelineName: args.timelineName,
	clips: args.clips.map((clip) => ({
		sourcePath: absolute(clip.sourcePath, 'sourcePath'),
		startFrame: clip.startFrame,
		endFrame: clip.endFrame,
		includeAudio: clip.includeAudio !== false,
	})),
});

const withFingerprint = (
	spec: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => ({
	...spec,
	fingerprint: `artists:davinci-selects:v1:${digest(spec)}`,
});

export class DavinciWorkflowEngine {
	constructor(
		private readonly bridge: ResolveBridgeClient,
		private readonly gate = new PlanGate()
	) {}

	async probe(): Promise<ProbeResponse> {
		try {
			return bridgeValue(await this.bridge.call('probe', {}), probeResponseSchema);
		} catch (error) {
			if (error instanceof BridgeProcessError) return disconnectedProbe(error);
			throw error;
		}
	}

	async projectSetup(args: ProjectSetupArgs): Promise<unknown> {
		const spec = projectSpec(args);
		const plan = await this.plan('project_setup_plan', spec, projectPlanSchema);
		if (args.dryRun) return { dryRun: true, ...this.gate.issue('project-setup', spec, plan), plan };

		this.gate.verify('project-setup', args.planToken, spec, plan);
		if (plan.actions.length === 0) {
			this.gate.consume(args.planToken);
			return this.upToDate('project-setup', plan);
		}
		const result = await this.apply(
			'project_setup_apply',
			spec,
			'project-setup',
			args.planToken
		);
		return this.verifyProjectResult(result);
	}

	async binsSync(args: BinsSyncArgs): Promise<unknown> {
		const spec = binsSpec(args);
		const plan = await this.plan('bins_sync_plan', spec, binsPlanSchema);
		if (args.dryRun) return { dryRun: true, ...this.gate.issue('bins-sync', spec, plan), plan };

		this.gate.verify('bins-sync', args.planToken, spec, plan);
		if (plan.actions.length === 0) {
			this.gate.consume(args.planToken);
			return this.upToDate('bins-sync', plan);
		}
		const result = await this.apply('bins_sync_apply', spec, 'bins-sync', args.planToken);
		return this.verifyBinsResult(result);
	}

	async selectsBuild(args: SelectsBuildArgs): Promise<unknown> {
		const spec = withFingerprint(selectsSpec(args));
		const plan = await this.plan('selects_build_plan', spec, selectsPlanSchema);
		if (args.dryRun) {
			return { dryRun: true, ...this.gate.issue('selects-build', spec, plan), plan };
		}

		this.gate.verify('selects-build', args.planToken, spec, plan);
		if (plan.status === 'up-to-date') {
			this.gate.consume(args.planToken);
			return this.upToDate('selects-build', plan);
		}
		const result = await this.apply(
			'selects_build_apply',
			spec,
			'selects-build',
			args.planToken
		);
		return this.verifySelectsResult(result);
	}

	async close(): Promise<void> {
		await this.bridge.close();
	}

	private async plan<T>(
		action: BridgeAction,
		spec: Readonly<Record<string, unknown>>,
		schema: z.ZodType<T>
	): Promise<T> {
		try {
			return bridgeValue(await this.bridge.call(action, spec), schema);
		} catch (error) {
			if (error instanceof BridgeProcessError) {
				throw new Refusal('resolve-unavailable', error.message);
			}
			throw error;
		}
	}

	private async apply(
		action: BridgeAction,
		spec: Readonly<Record<string, unknown>>,
		operation: Operation,
		token: string | undefined
	): Promise<WriteResult> {
		try {
			return bridgeValue(await this.bridge.call(action, spec), writeResultSchema);
		} catch (error) {
			if (error instanceof BridgeProcessError) {
				throw new Refusal(
					'resolve-unavailable',
					`${error.message} The bridge may have stopped after a partial write; inspect Resolve before retrying.`
				);
			}
			throw error;
		} finally {
			this.gate.consume(token);
		}
	}

	private verifyProjectResult(result: WriteResult): unknown {
		const readback = bridgeValue(result.readback, projectPlanSchema);
		return this.verifiedResult(result, readback, readback.actions.length === 0);
	}

	private verifyBinsResult(result: WriteResult): unknown {
		const readback = bridgeValue(result.readback, binsPlanSchema);
		return this.verifiedResult(result, readback, readback.actions.length === 0);
	}

	private verifySelectsResult(result: WriteResult): unknown {
		const readback = bridgeValue(result.readback, selectsPlanSchema);
		return this.verifiedResult(result, readback, readback.status === 'up-to-date');
	}

	private verifiedResult<T>(result: WriteResult, readback: T, independentlyVerified: boolean): unknown {
		const verified = result.verified && independentlyVerified;
		return {
			dryRun: false,
			...result,
			status: verified ? result.status : 'partial',
			verified,
			errors: verified
				? result.errors
				: [...result.errors, 'Readback does not match the requested declarative state.'],
			readback,
		};
	}

	private upToDate(
		operation: Operation,
		readback: ProjectPlan | BinsPlan | SelectsPlan
	): unknown {
		return {
			dryRun: false,
			operation,
			status: 'up-to-date',
			changed: false,
			verified: true,
			errors: [],
			readback,
		};
	}
}
