'use strict';

const assert = require('assert').strict;

const Sim = require('./../../dist/sim');
const { Runner } = require('./../../dist/sim/tools/runner');

function missingCommand() {
	if (process.platform === 'win32') return '___nonexistent.exe';
	return '/__nonexistent_binary__';
}

describe('NativeBattleStream', () => {
	it('should fall back to the JS simulator when native process is unavailable', async function () {
		this.timeout(0);

		let warned = false;
		const originalWarn = console.warn;
		console.warn = message => {
			if (typeof message === 'string' && message.includes('[NativeBattleStream]')) warned = true;
		};

		try {
			const runner = new Runner({
				format: 'gen1customgame',
				dual: {
					testStreamFactory: () => new Sim.NativeBattleStream({
						process: { command: missingCommand() },
						fallbackFactory: () => new Sim.BattleStream(),
					}),
				},
			});

			await runner.run();
		} finally {
			console.warn = originalWarn;
		}

		assert.ok(warned, 'Expected NativeBattleStream to issue a fallback warning');
	});
});
