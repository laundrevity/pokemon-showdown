/**
 * Native Battle Stream
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Proxies the standard BattleStream protocol to an external process, enabling
 * integration with native simulators (e.g., a C++ engine).
 *
 * @license MIT
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';

import { BattleStream } from './battle-stream';

const DEFAULT_TERMINATOR = '\n\n';

export interface NativeProcessOptions {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

type BaseBattleStreamOptions = ConstructorParameters<typeof BattleStream>[0];

export interface NativeBattleStreamOptions extends BaseBattleStreamOptions {
	process: NativeProcessOptions;
	terminator?: string;
	fallbackFactory?: () => BattleStream;
}

/**
 * A BattleStream whose implementation is delegated to an external process.
 *
 * Communication uses the usual Showdown simulator protocol on stdin/stdout:
 * - Input lines must start with the standard command prefix (e.g. `>start`).
 * - Output messages must be terminated by `terminator` (default: blank line).
 */
export class NativeBattleStream extends BattleStream {
	private readonly terminator: string;
	private readonly fallbackFactory?: () => BattleStream;
	private process: ChildProcessWithoutNullStreams | null;
	private stdoutBuffer: string;
	private fallbackStream: BattleStream | null;
	private ended: boolean;

	constructor(options: NativeBattleStreamOptions) {
		const { process: processOptions, terminator, fallbackFactory, ...streamOptions } = options;
		if (!processOptions || !processOptions.command) {
			throw new Error('NativeBattleStream requires a process command');
		}
		super(streamOptions);

		this.terminator = terminator ?? DEFAULT_TERMINATOR;
		this.process = null;
		this.fallbackFactory = fallbackFactory;
		this.stdoutBuffer = '';
		this.fallbackStream = null;
		this.ended = false;

		try {
			this.spawnProcess(processOptions);
		} catch (err) {
			this.activateFallback(err as Error);
		}
	}

	override _write(message: string) {
		if (this.fallbackStream) {
			void this.fallbackStream.write(message);
			return;
		}
		if (!this.process) {
			throw new Error('Native battle stream is not available');
		}
		if (!this.process.stdin.writable) {
			throw new Error('Native battle stream stdin is closed');
		}
		const chunk = message.endsWith('\n') ? message : `${message}\n`;
		this.process.stdin.write(chunk);
	}

	override _writeEnd() {
		if (this.fallbackStream) {
			void this.fallbackStream.writeEnd();
			return;
		}
		this.ended = true;
		if (this.process && this.process.stdin.writable) {
			this.process.stdin.end();
		}
	}

	override _destroy() {
		if (this.fallbackStream) {
			this.fallbackStream.destroy();
			this.fallbackStream = null;
		}
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
	}

	private spawnProcess(options: NativeProcessOptions) {
		const env = options.env ? { ...process.env, ...options.env } : process.env;
		this.process = spawn(options.command, options.args ?? [], {
			cwd: options.cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.process.once('error', err => {
			if (!this.fallbackStream) this.activateFallback(err);
		});

		this.process.stderr.on('data', data => {
			const text = data.toString();
			if (text.trim()) {
				console.error(`[NativeBattleStream stderr] ${text.trimEnd()}`);
			}
		});

		const stdout = readline.createInterface({ input: this.process.stdout });
		stdout.on('line', line => {
			this.stdoutBuffer += line + '\n';
			this.flushStdout();
		});
		stdout.on('close', () => this.flushStdout(true));

		this.process.once('exit', (code, signal) => {
			if (this.fallbackStream) return;
			if (!this.ended) {
				const reason = code === 0 ? 'unexpected close' : `exit code ${code ?? 'null'} signal ${signal ?? 'null'}`;
				this.pushError(new Error(`Native simulator ${reason}`));
			}
			this.pushEnd();
		});
	}

	private flushStdout(force = false) {
		const terminator = this.terminator;
		let index = this.stdoutBuffer.indexOf(terminator);
		while (index !== -1) {
			const chunk = this.stdoutBuffer.slice(0, index);
			this.stdoutBuffer = this.stdoutBuffer.slice(index + terminator.length);
			if (chunk.length) this.push(chunk);
			index = this.stdoutBuffer.indexOf(terminator);
		}
		if (force && this.stdoutBuffer.length) {
			this.push(this.stdoutBuffer);
			this.stdoutBuffer = '';
		}
		if (force) this.pushEnd();
	}

	private activateFallback(reason: Error) {
		if (!this.fallbackFactory) {
			throw reason;
		}
		console.warn(`[NativeBattleStream] Falling back to JS engine: ${reason.message}`);
		this.process = null;
		this.stdoutBuffer = '';
		const fallback = this.fallbackFactory();
		this.fallbackStream = fallback;
		(async () => {
			try {
				for await (const chunk of fallback) {
					this.push(chunk);
				}
				this.pushEnd();
			} catch (err) {
				this.pushError(err as Error);
			}
		})();
	}
}
