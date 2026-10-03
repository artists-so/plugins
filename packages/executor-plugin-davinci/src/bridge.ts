import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export type BridgeAction =
	| 'probe'
	| 'project_setup_plan'
	| 'project_setup_apply'
	| 'bins_sync_plan'
	| 'bins_sync_apply'
	| 'selects_build_plan'
	| 'selects_build_apply';

export interface ResolveBridgeClient {
	call(action: BridgeAction, payload: Readonly<Record<string, unknown>>): Promise<unknown>;
	close(): Promise<void>;
}

interface PendingCall {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface BridgeEnvelope {
	readonly id: number;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: {
		readonly code: string;
		readonly message: string;
	};
}

export class BridgeProcessError extends Error {
	override readonly name = 'BridgeProcessError';

	constructor(
		message: string,
		readonly code = 'bridge-process'
	) {
		super(message);
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function envelopeFrom(value: unknown): BridgeEnvelope | undefined {
	if (!isRecord(value) || typeof value['id'] !== 'number' || typeof value['ok'] !== 'boolean') {
		return undefined;
	}
	const error = value['error'];
	if (error !== undefined) {
		if (
			!isRecord(error) ||
			typeof error['code'] !== 'string' ||
			typeof error['message'] !== 'string'
		) {
			return undefined;
		}
		return {
			id: value['id'],
			ok: value['ok'],
			...(value['result'] === undefined ? {} : { result: value['result'] }),
			error: { code: error['code'], message: error['message'] },
		};
	}
	return {
		id: value['id'],
		ok: value['ok'],
		...(value['result'] === undefined ? {} : { result: value['result'] }),
	};
}

const bridgeScript = fileURLToPath(new URL('./resolve_bridge.py', import.meta.url));

const defaultResolvePaths = (): {
	readonly apiRoot?: string;
	readonly scriptLibrary?: string;
} => {
	switch (process.platform) {
		case 'darwin':
			return {
				apiRoot:
					'/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
				scriptLibrary:
					'/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so',
			};
		case 'linux':
			return {
				apiRoot: '/opt/resolve/Developer/Scripting',
				scriptLibrary: '/opt/resolve/libs/Fusion/fusionscript.so',
			};
		case 'win32':
			return {
				apiRoot:
					'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting',
				scriptLibrary:
					'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll',
			};
		default:
			return {};
	}
};

export class PersistentResolveBridge implements ResolveBridgeClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private lines: ReadlineInterface | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingCall>();
	private stderr = '';
	private protocolNoise = '';

	constructor(
		private readonly python =
			process.env['ARTISTS_DAVINCI_PYTHON'] ??
			process.env['DAVINCI_RESOLVE_MCP_PYTHON'] ??
			'python3',
		private readonly script = bridgeScript,
		private readonly timeoutMs = Number(process.env['ARTISTS_DAVINCI_TIMEOUT_MS'] ?? 120_000)
	) {}

	async call(
		action: BridgeAction,
		payload: Readonly<Record<string, unknown>>
	): Promise<unknown> {
		const child = this.ensureProcess();
		const id = this.nextId++;
		const request = `${JSON.stringify({ id, action, payload })}\n`;

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new BridgeProcessError(
						`Resolve bridge timed out after ${this.timeoutMs} ms while running ${action}.${this.diagnostics()}`
					)
				);
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });

			child.stdin.write(request, 'utf8', (error) => {
				if (error === null || error === undefined) return;
				const pending = this.pending.get(id);
				if (pending === undefined) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(
					new BridgeProcessError(`Could not write to Resolve bridge: ${error.message}`)
				);
			});
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		if (child === undefined) return;
		this.lines?.close();
		this.lines = undefined;
		this.child = undefined;
		child.kill();
		this.failAll(new BridgeProcessError('Resolve bridge was closed.'));
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		const current = this.child;
		if (current !== undefined && current.exitCode === null && !current.killed) return current;

		this.stderr = '';
		this.protocolNoise = '';
		const defaults = defaultResolvePaths();
		const apiRoot = process.env['RESOLVE_SCRIPT_API'] ?? defaults.apiRoot;
		const scriptLibrary = process.env['RESOLVE_SCRIPT_LIB'] ?? defaults.scriptLibrary;
		const modulePath = apiRoot === undefined ? undefined : join(apiRoot, 'Modules');
		const pythonPath = [process.env['PYTHONPATH'], modulePath].filter(
			(value): value is string => value !== undefined && value.length > 0
		);
		const child = spawn(this.python, ['-u', this.script], {
			env: {
				...process.env,
				PYTHONUNBUFFERED: '1',
				...(apiRoot === undefined ? {} : { RESOLVE_SCRIPT_API: apiRoot }),
				...(scriptLibrary === undefined ? {} : { RESOLVE_SCRIPT_LIB: scriptLibrary }),
				...(pythonPath.length === 0 ? {} : { PYTHONPATH: pythonPath.join(delimiter) }),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.child = child;

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string | Buffer) => {
			this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000);
		});

		const lines = createInterface({ input: child.stdout });
		this.lines = lines;
		lines.on('line', (line) => {
			this.receive(line);
		});

		child.once('error', (error) => {
			this.child = undefined;
			this.failAll(
				new BridgeProcessError(
					`Could not start Resolve bridge with ${this.python}: ${error.message}.${this.diagnostics()}`
				)
			);
		});
		child.once('exit', (code, signal) => {
			if (this.child === child) this.child = undefined;
			const suffix = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
			this.failAll(
				new BridgeProcessError(`Resolve bridge stopped with ${suffix}.${this.diagnostics()}`)
			);
		});

		return child;
	}

	private receive(line: string): void {
		let decoded: unknown;
		try {
			decoded = JSON.parse(line) as unknown;
		} catch {
			this.protocolNoise = `${this.protocolNoise}\n${line}`.slice(-2_000);
			return;
		}
		const envelope = envelopeFrom(decoded);
		if (envelope === undefined) {
			this.protocolNoise = `${this.protocolNoise}\n${line}`.slice(-2_000);
			return;
		}
		const pending = this.pending.get(envelope.id);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.pending.delete(envelope.id);

		if (envelope.ok) {
			pending.resolve(envelope.result);
			return;
		}
		pending.reject(
			new BridgeProcessError(
				envelope.error?.message ?? `Resolve bridge action failed.${this.diagnostics()}`,
				envelope.error?.code
			)
		);
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private diagnostics(): string {
		const details = [this.stderr.trim(), this.protocolNoise.trim()].filter(Boolean).join('\n');
		return details.length === 0 ? '' : ` Bridge output: ${details}`;
	}
}
