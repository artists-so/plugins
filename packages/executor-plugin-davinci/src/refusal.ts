export type RefusalCode =
	| 'resolve-unavailable'
	| 'project-not-current'
	| 'project-missing'
	| 'source-missing'
	| 'source-ambiguous'
	| 'source-already-imported-elsewhere'
	| 'timeline-conflict'
	| 'invalid-plan'
	| 'plan-required'
	| 'plan-stale';

export class Refusal extends Error {
	override readonly name = 'Refusal';

	constructor(
		readonly code: RefusalCode,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export interface RefusalPayload {
	readonly refused: RefusalCode;
	readonly message: string;
	readonly details?: unknown;
}

export const isRefusal = (error: unknown): error is Refusal => error instanceof Refusal;

export const refusalPayload = (error: Refusal): RefusalPayload => ({
	refused: error.code,
	message: error.message,
	...(error.details === undefined ? {} : { details: error.details }),
});
