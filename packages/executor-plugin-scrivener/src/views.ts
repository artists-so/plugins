/**
 * The shape `binder_read` answers with.
 *
 * Separate from the tool definition so that the sample output quoted in the
 * READMEs can be rendered by a script from the same code the tool runs
 * (`scripts/sample-output.ts`). Documentation that is generated cannot
 * describe a response the plugin stopped giving.
 */

import type { ScrivenerProject } from './project.js';
import { outlineText } from './reconcile.js';

export interface BinderReadOptions {
	readonly root?: string | undefined;
	readonly as?: 'tree' | 'text' | undefined;
}

export function binderReadResult(
	project: ScrivenerProject,
	options: BinderReadOptions = {}
): Record<string, unknown> {
	const from = options.root === undefined ? undefined : project.resolveRoot(options.root);
	const tree = project.read(from);
	return {
		labels: project.labels().map((entry) => entry.title),
		statuses: project.statuses().map((entry) => entry.title),
		...(options.as === 'text' ? { outline: outlineText(tree).join('\n') } : { binder: tree }),
	};
}
