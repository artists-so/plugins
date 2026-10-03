import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SourceCatalogArgs } from './contracts.js';
import { Refusal } from './refusal.js';

const DEFAULT_EXTENSIONS = [
	'avi',
	'braw',
	'cin',
	'dpx',
	'm4a',
	'mkv',
	'mov',
	'mp3',
	'mp4',
	'mts',
	'mxf',
	'r3d',
	'wav',
	'webm',
] as const;

export interface CatalogClip {
	readonly path: string;
	readonly relativePath: string;
	readonly binPath: string;
	readonly extension: string;
	readonly bytes: number;
	readonly modifiedAt: string;
}

export interface CatalogBin {
	readonly path: string;
	readonly sources: readonly string[];
	readonly clips: number;
	readonly bytes: number;
}

export interface SourceCatalog {
	readonly sourceRoot: string;
	readonly binRoot: string;
	readonly clips: readonly CatalogClip[];
	readonly bins: readonly CatalogBin[];
	readonly summary: {
		readonly clips: number;
		readonly bins: number;
		readonly bytes: number;
		readonly skippedSymlinks: number;
		readonly extensions: Readonly<Record<string, number>>;
	};
}

const normalizeExtension = (value: string): string =>
	value.trim().toLowerCase().replace(/^\.+/, '');

const hidden = (name: string): boolean => name.startsWith('.') || name.startsWith('._');

const toBinPath = (root: string, file: string, binRoot: string): string => {
	const parent = relative(root, dirname(file));
	if (parent.length === 0) return binRoot;
	const nested = parent.split(sep).filter(Boolean).join('/');
	return nested.length === 0 ? binRoot : `${binRoot}/${nested}`;
};

export async function buildSourceCatalog(args: SourceCatalogArgs): Promise<SourceCatalog> {
	if (!isAbsolute(args.sourceRoot)) {
		throw new Refusal('invalid-plan', 'sourceRoot must be an absolute directory path.');
	}
	const sourceRoot = resolve(args.sourceRoot);
	const binRoot = args.binRoot?.replace(/^\/+|\/+$/g, '') || '01 Sources';
	const extensions = new Set(
		(args.extensions ?? [...DEFAULT_EXTENSIONS]).map(normalizeExtension).filter(Boolean)
	);
	const maxFiles = args.maxFiles ?? 10_000;
	const includeHidden = args.includeHidden === true;

	let rootStat: Awaited<ReturnType<typeof stat>>;
	try {
		rootStat = await stat(sourceRoot);
	} catch (error) {
		throw new Refusal(
			'invalid-plan',
			`Source directory is not readable: ${sourceRoot}`,
			error instanceof Error ? error.message : String(error)
		);
	}
	if (!rootStat.isDirectory()) {
		throw new Refusal('invalid-plan', `Source root is not a directory: ${sourceRoot}`);
	}

	const files: string[] = [];
	let skippedSymlinks = 0;

	const walk = async (directory: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
			left.name.localeCompare(right.name)
		);
		for (const entry of entries) {
			if (!includeHidden && hidden(entry.name)) continue;
			const path = resolve(directory, entry.name);
			if (entry.isSymbolicLink()) {
				skippedSymlinks++;
				continue;
			}
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = normalizeExtension(extname(entry.name));
			if (!extensions.has(extension)) continue;
			files.push(path);
			if (files.length > maxFiles) {
				throw new Refusal(
					'invalid-plan',
					`Source scan exceeded maxFiles (${maxFiles}). Raise the explicit ceiling only after narrowing or reviewing the source root.`
				);
			}
		}
	};

	await walk(sourceRoot);

	const clips: CatalogClip[] = [];
	const bins = new Map<string, { sources: string[]; clips: number; bytes: number }>();
	const extensionCounts: Record<string, number> = {};
	let totalBytes = 0;

	for (const path of files) {
		const fileStat = await stat(path);
		const extension = normalizeExtension(extname(path));
		const binPath = toBinPath(sourceRoot, path, binRoot);
		const clip: CatalogClip = {
			path,
			relativePath: relative(sourceRoot, path).split(sep).join('/'),
			binPath,
			extension,
			bytes: fileStat.size,
			modifiedAt: fileStat.mtime.toISOString(),
		};
		clips.push(clip);
		totalBytes += fileStat.size;
		extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
		const bin = bins.get(binPath) ?? { sources: [], clips: 0, bytes: 0 };
		bin.sources.push(path);
		bin.clips++;
		bin.bytes += fileStat.size;
		bins.set(binPath, bin);
	}

	return {
		sourceRoot,
		binRoot,
		clips,
		bins: [...bins.entries()]
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([path, bin]) => ({
				path,
				sources: bin.sources,
				clips: bin.clips,
				bytes: bin.bytes,
			})),
		summary: {
			clips: clips.length,
			bins: bins.size,
			bytes: totalBytes,
			skippedSymlinks,
			extensions: Object.fromEntries(
				Object.entries(extensionCounts).toSorted(([left], [right]) =>
					left.localeCompare(right)
				)
			),
		},
	};
}
