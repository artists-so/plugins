/**
 * Refusals: the conditions where the right answer is "no, and here is why".
 *
 * They are separated from ordinary errors because of how the runtime treats a
 * failed tool. An Effect failure — or any thrown error — reaches the caller as
 * `Internal tool error [<correlation id>]`, with the message kept in the
 * daemon log where the agent cannot see it (verified against executor 1.5.40,
 * 2026-08-09). For a bug that is acceptable. For "Scrivener is open, your
 * write would be silently overwritten" it is the opposite of the intent: the
 * whole value of the guard is the sentence explaining what to do instead.
 *
 * So an expected refusal is thrown as a `Refusal` and delivered as *data* —
 * `{ refused, message }`, and deliberately nothing that could be mistaken for
 * a result. Genuine faults keep failing, and keep their opaque id.
 */

export type RefusalCode =
	/** Scrivener is running, or a lock file says another machine has it open. */
	| 'scrivener-open'
	/** The .scrivx moved on disk after it was read; saving would destroy that write. */
	| 'changed-on-disk'
	/** A label or status name the project does not define. */
	| 'unknown-vocabulary'
	/** No project at that path, or it is not a .scriv package. */
	| 'project-unreadable'
	/** No binder item with that id. */
	| 'item-missing';

export class Refusal extends Error {
	override readonly name = 'Refusal';

	constructor(
		readonly code: RefusalCode,
		message: string
	) {
		super(message);
	}
}

export interface RefusalPayload {
	readonly refused: RefusalCode;
	readonly message: string;
}

export const isRefusal = (error: unknown): error is Refusal => error instanceof Refusal;

export const refusalPayload = (error: Refusal): RefusalPayload => ({
	refused: error.code,
	message: error.message,
});
