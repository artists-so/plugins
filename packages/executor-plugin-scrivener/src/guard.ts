/**
 * Protection against writing into a project Scrivener is using.
 *
 * Scrivener holds the binder in memory while a project is open and rewrites
 * the .scrivx on auto-save, so an external write during a session is silently
 * lost minutes later. Literature & Latte's documented signal is a `user.lock`
 * file inside the package, written on open and deleted on close — but
 * verified on macOS Scrivener 3.5.2 (2026-08-08): no lock file is written at
 * all while a project is open, and the app exposes no scripting surface and
 * holds no persistent file handles. So the guard is layered:
 *
 *   1. `user.lock` / `Files/user.lock` — authoritative where it exists
 *      (older versions, Windows, synced machines).
 *   2. A running Scrivener process (macOS) — conservative: it cannot tell
 *      WHICH project is open, so it can false-positive on an unrelated one.
 *      That is the acceptable direction of error; `force` overrides.
 *
 * The third layer lives in the engine itself: ScrivenerProject records the
 * .scrivx mtime it parsed and refuses to save over a file that changed
 * underneath it, which catches every external writer including sync clients.
 */

import { execFile } from 'child_process';
import { access } from 'fs/promises';
import { join } from 'path';

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

const scrivenerProcessRunning = async (): Promise<boolean> => {
	if (process.platform !== 'darwin') return false;
	return new Promise((resolve) => {
		execFile('pgrep', ['-x', 'Scrivener'], (error) => resolve(error === null));
	});
};

export interface WriteHazardOptions {
	/** Set false in tests: the lock-file layers stay testable without a Scrivener install. */
	readonly checkProcess?: boolean;
}

/**
 * Returns a human-readable reason the project must not be written to right
 * now, or undefined when writing is safe.
 */
export async function writeHazard(
	projectPath: string,
	options: WriteHazardOptions = {}
): Promise<string | undefined> {
	if (await exists(join(projectPath, 'Files', 'user.lock'))) {
		return 'The project contains Files/user.lock — Scrivener has it open (possibly on another machine). Close it there first, or pass force: true if you know the lock is stale.';
	}
	if (await exists(join(projectPath, 'user.lock'))) {
		return 'The project contains user.lock — Scrivener has it open (possibly on another machine). Close it there first, or pass force: true if you know the lock is stale.';
	}
	if (options.checkProcess !== false && (await scrivenerProcessRunning())) {
		return 'Scrivener is running on this machine. If this project is open in it, writes made now will be silently overwritten by its next auto-save. Quit Scrivener and retry, or pass force: true if a different project is open.';
	}
	return undefined;
}
