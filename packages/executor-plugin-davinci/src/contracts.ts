import { z } from 'zod';

export const refusalSchema = z.object({
	refused: z.string(),
	message: z.string(),
	details: z.unknown().optional(),
});

export type RefusalResponse = z.infer<typeof refusalSchema>;

export const probeArgs = z.object({});

export const probeResponseSchema = z.object({
	connected: z.boolean(),
	product: z.string().nullable(),
	version: z.string().nullable(),
	versionFields: z.array(z.union([z.string(), z.number()])),
	currentProject: z.string().nullable(),
	currentPage: z.string().nullable(),
	apiModulePath: z.string().nullable(),
	pythonVersion: z.string(),
	capabilities: z.object({
		projectSetup: z.boolean(),
		mediaPoolFolders: z.boolean(),
		mediaImport: z.boolean(),
		timelineCreate: z.boolean(),
		timelineAppend: z.boolean(),
		timelineReadback: z.boolean(),
		intelliSearch: z.boolean(),
	}),
	message: z.string(),
});

export type ProbeResponse = z.infer<typeof probeResponseSchema>;

const projectName = z.string().trim().min(1).describe('Exact Resolve project name');
const relativeBinPath = z
	.string()
	.trim()
	.min(1)
	.describe('Media Pool path relative to the root, using "/" between folders');
const dryRun = z
	.boolean()
	.describe('Use true first to receive a plan token; false applies that exact reviewed plan');
const planToken = z
	.string()
	.optional()
	.describe('Token returned by the matching dry run; required when dryRun is false');

export const projectSetupArgs = z.object({
	projectName,
	mediaLocationPath: z
		.string()
		.optional()
		.describe('Optional media location used only when creating a new project'),
	settings: z
		.record(z.string(), z.string())
		.optional()
		.describe('Resolve project setting keys and string values'),
	binPaths: z
		.array(relativeBinPath)
		.optional()
		.describe('Media Pool folders to ensure, including nested paths'),
	dryRun,
	planToken,
});

export type ProjectSetupArgs = z.infer<typeof projectSetupArgs>;

export const sourceCatalogArgs = z.object({
	sourceRoot: z.string().describe('Absolute source directory to scan without modifying it'),
	binRoot: relativeBinPath
		.optional()
		.describe('Media Pool prefix for generated bins; defaults to "01 Sources"'),
	extensions: z
		.array(z.string().trim().min(1))
		.optional()
		.describe('Case-insensitive extensions to include; dots are optional'),
	includeHidden: z
		.boolean()
		.optional()
		.describe('Include hidden files and directories; defaults to false'),
	maxFiles: z
		.number()
		.int()
		.positive()
		.max(100_000)
		.optional()
		.describe('Safety ceiling; defaults to 10,000 media files'),
});

export type SourceCatalogArgs = z.infer<typeof sourceCatalogArgs>;

export const binSpecSchema = z.object({
	path: relativeBinPath,
	sources: z
		.array(z.string())
		.min(1)
		.describe('Absolute source file paths that should be imported into this bin'),
});

export const binsSyncArgs = z.object({
	projectName,
	bins: z.array(binSpecSchema).min(1),
	dryRun,
	planToken,
});

export type BinsSyncArgs = z.infer<typeof binsSyncArgs>;
export type BinSpec = z.infer<typeof binSpecSchema>;

export const selectsClipSchema = z
	.object({
		sourcePath: z.string().describe('Absolute path of a source already present in the Media Pool'),
		startFrame: z.number().int().nonnegative(),
		endFrame: z.number().int().positive(),
		includeAudio: z
			.boolean()
			.optional()
			.describe('Keep linked source audio; defaults to true'),
	})
	.refine((clip) => clip.endFrame > clip.startFrame, {
		message: 'endFrame must be greater than startFrame',
		path: ['endFrame'],
	});

export const selectsBuildArgs = z.object({
	projectName,
	timelineName: z
		.string()
		.trim()
		.min(1)
		.describe('Name of the new selects variant; an unrelated existing timeline is never replaced'),
	clips: z.array(selectsClipSchema).min(1),
	dryRun,
	planToken,
});

export type SelectsBuildArgs = z.infer<typeof selectsBuildArgs>;
export type SelectsClip = z.infer<typeof selectsClipSchema>;

export const projectActionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('create-project'),
		projectName: z.string(),
	}),
	z.object({
		kind: z.literal('set-setting'),
		key: z.string(),
		from: z.string().nullable(),
		to: z.string(),
	}),
	z.object({
		kind: z.literal('create-bin'),
		path: z.string(),
	}),
]);

export const projectReadbackSchema = z.object({
	exists: z.boolean(),
	currentProject: z.string().nullable(),
	settings: z.record(z.string(), z.string()),
	bins: z.array(z.string()),
});

export const projectPlanSchema = z.object({
	operation: z.literal('project-setup'),
	projectName: z.string(),
	actions: z.array(projectActionSchema),
	readback: projectReadbackSchema,
});

export type ProjectPlan = z.infer<typeof projectPlanSchema>;

export const binsActionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('create-bin'),
		path: z.string(),
	}),
	z.object({
		kind: z.literal('import-source'),
		sourcePath: z.string(),
		binPath: z.string(),
	}),
]);

export const binsPlanSchema = z.object({
	operation: z.literal('bins-sync'),
	projectName: z.string(),
	actions: z.array(binsActionSchema),
	alreadyPresent: z.array(
		z.object({
			sourcePath: z.string(),
			binPath: z.string(),
		})
	),
});

export type BinsPlan = z.infer<typeof binsPlanSchema>;

export const selectsReadbackClipSchema = z.object({
	sourcePath: z.string(),
	startFrame: z.number(),
	endFrame: z.number(),
});

export const selectsPlanSchema = z.object({
	operation: z.literal('selects-build'),
	projectName: z.string(),
	timelineName: z.string(),
	status: z.enum(['create', 'up-to-date']),
	fingerprint: z.string(),
	clips: z.array(selectsReadbackClipSchema),
});

export type SelectsPlan = z.infer<typeof selectsPlanSchema>;

export const writeResultSchema = z.object({
	operation: z.enum(['project-setup', 'bins-sync', 'selects-build']),
	status: z.enum(['applied', 'partial', 'up-to-date']),
	changed: z.boolean(),
	verified: z.boolean(),
	errors: z.array(z.string()),
	readback: z.unknown(),
});

export type WriteResult = z.infer<typeof writeResultSchema>;
