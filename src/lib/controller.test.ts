/**
 * Unit tests for the multi-head controller (mocked adapter + hooks, no hardware).
 */

import { expect } from 'chai';
import type { ControllerConfig, ControllerHooks } from './controller';
import { MultiHeadController } from './controller';
import type { HeadState } from './split';

/** Records every state write so tests can assert on telemetry. */
interface MockAdapter {
	adapter: ioBroker.Adapter;
	states: Record<string, unknown>;
	setGridSource(ts: number): void;
}

function mockAdapter(): MockAdapter {
	const states: Record<string, unknown> = {};
	let gridSourceTs = Date.now();
	const adapter = {
		log: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
		setStateChangedAsync: (id: string, val: unknown) => {
			states[id] = val;
			return Promise.resolve();
		},
		getForeignStateAsync: () => Promise.resolve({ ts: gridSourceTs, val: 0, ack: true }),
		setInterval: () => undefined,
		clearInterval: () => undefined,
	} as unknown as ioBroker.Adapter;
	return {
		adapter,
		states,
		setGridSource: (ts: number) => {
			gridSourceTs = ts;
		},
	};
}

interface MockHooks {
	hooks: ControllerHooks;
	writes: { index: number; gs: number }[];
	/** Head indexes whose writeGs should throw. */
	failing: Set<number>;
}

function mockHooks(heads: HeadState[]): MockHooks {
	const writes: { index: number; gs: number }[] = [];
	const failing = new Set<number>();
	return {
		writes,
		failing,
		hooks: {
			getHeads: () => heads,
			writeGs: (index, gs) => {
				if (failing.has(index)) {
					return Promise.reject(new Error('write failed'));
				}
				writes.push({ index, gs });
				return Promise.resolve();
			},
			reflectGs: () => Promise.resolve(),
		},
	};
}

/**
 * Build a head with sensible defaults (PRO: 2400 W, half full, online).
 *
 * @param partial Overrides merged onto the defaults (index is required).
 */
function head(partial: Partial<HeadState> & { index: number }): HeadState {
	return { online: true, gp: 0, soc: 50, socMin: 10, socMax: 100, maxPower: 2400, ...partial };
}

/**
 * Default controller config for tests: no throttling, no dead bands.
 *
 * @param partial Overrides merged onto the defaults.
 */
function cfg(partial: Partial<ControllerConfig> = {}): ControllerConfig {
	return {
		targetW: 0,
		gain: 1,
		deadBandW: 0,
		maxStepW: 0,
		minIntervalMs: 0,
		writeDeadBandW: 0,
		inverted: false,
		warnSec: 30,
		failsafeSec: 180,
		...partial,
	};
}

describe('MultiHeadController', () => {
	it('starts by neutralizing all heads to GS=0', async () => {
		const heads = [head({ index: 1 }), head({ index: 2, online: false })];
		const { hooks, writes } = mockHooks(heads);
		const { adapter, states } = mockAdapter();
		const ctrl = new MultiHeadController(adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		// start() writes to every head (heads are offline before the first poll)
		expect(writes).to.deep.equal([
			{ index: 1, gs: 0 },
			{ index: 2, gs: 0 },
		]);
		expect(states['controller.status']).to.equal('ok');
	});

	it('regulates on a grid event and splits across heads', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000); // draw 1000 W → discharge 1000 W total
		expect(writes).to.deep.equal([
			{ index: 1, gs: 500 },
			{ index: 2, gs: 500 },
		]);
	});

	it('integrates towards zero using the last commanded GS as base', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ gain: 0.5 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000); // base 0 → 500
		await ctrl.onGridPower(500); // base 500 → 750
		await ctrl.onGridPower(250); // base 750 → 875
		expect(writes.map(w => w.gs)).to.deep.equal([500, 750, 875]);
	});

	it('regulates towards a configured target grid power (deliberate draw)', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ targetW: 100, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(300); // 200 W above the 100 W draw target → discharge 200 W
		expect(writes).to.deep.equal([{ index: 1, gs: 200 }]);
		await ctrl.onGridPower(100); // exactly on target → no change
		expect(writes.length).to.equal(1);
	});

	it('caps the setpoint movement per correction (step limit)', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ maxStepW: 200, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000); // raw target 1000, capped to base 0 + 200
		await ctrl.onGridPower(800); // raw target 200+800=1000, capped to 200 + 200
		expect(writes).to.deep.equal([
			{ index: 1, gs: 200 },
			{ index: 1, gs: 400 },
		]);
	});

	it('does not cap when the step limit is 0 (unlimited)', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ maxStepW: 0 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000);
		expect(writes).to.deep.equal([{ index: 1, gs: 1000 }]);
	});

	it('respects an explicit dead band of zero and a configured one', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ deadBandW: 50 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(30); // inside the grid dead band → no write
		expect(writes).to.deep.equal([]);
		await ctrl.onGridPower(80); // outside → write
		expect(writes).to.deep.equal([{ index: 1, gs: 80 }]);
	});

	it('skips a head whose setpoint moved less than the write dead band', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ gain: 0.1, writeDeadBandW: 50 }),
		);
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(100); // target 10, change 10 < 50 → skipped
		expect(writes).to.deep.equal([]);
		await ctrl.onGridPower(1000); // target 100, change 100 ≥ 50 → written
		expect(writes).to.deep.equal([{ index: 1, gs: 100 }]);
	});

	it('throttles by the minimum write interval', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ minIntervalMs: 60000 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000); // first write allowed
		await ctrl.onGridPower(2000); // second event inside the interval → throttled
		expect(writes).to.deep.equal([{ index: 1, gs: 1000 }]);
	});

	it('keeps writing the remaining heads when one write fails', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		failing.add(1);
		await ctrl.onGridPower(1000);
		expect(writes).to.deep.equal([{ index: 2, gs: 500 }]);
	});

	it('adopts the reported GP as base when the device limits internally (anti-windup)', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ gain: 0.1, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		// Pretend 2000 W were commanded a while ago but the device only delivers 500 W.
		const internal = ctrl as unknown as { lastGs: Map<number, number>; lastWriteTime: number };
		internal.lastGs.set(1, 2000);
		internal.lastWriteTime = Date.now() - 60000;
		ctrl.noteReportedGp(1, 500); // deviation 1500 W → adopt 500 as base
		writes.length = 0;
		await ctrl.onGridPower(1000);
		// 500 + 0.1·1000 = 600 — without the adoption it would command 2100.
		expect(writes).to.deep.equal([{ index: 1, gs: 600 }]);
	});

	it('ignores reported GP while the last write is recent (device still ramping)', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const internal = ctrl as unknown as { lastGs: Map<number, number>; lastWriteTime: number };
		internal.lastGs.set(1, 2000);
		internal.lastWriteTime = Date.now(); // fresh write
		ctrl.noteReportedGp(1, 500);
		expect(internal.lastGs.get(1)).to.equal(2000);
	});

	it('forgets a head so its base falls back to the polled GP', async () => {
		const heads = [head({ index: 1, gp: 700 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ gain: 0 }));
		await ctrl.start(); // lastGs = 0
		writes.length = 0;
		ctrl.forgetHead(1);
		await ctrl.onGridPower(1000); // gain 0 → target = base = polled gp = 700
		expect(writes).to.deep.equal([{ index: 1, gs: 700 }]);
	});

	it('goes to failsafe (GS=0 on online heads) when the grid source is stale', async () => {
		const heads = [head({ index: 1 }), head({ index: 2, online: false })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 180 }));
		await ctrl.start();
		await ctrl.onGridPower(1000); // establishes everSeenSource and a non-zero GS
		writes.length = 0;
		mock.setGridSource(Date.now() - 300000); // 300 s old → beyond failsafe
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(mock.states['controller.status']).to.equal('failsafe');
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]); // online head only
		// A second tick must not re-write (already at 0) — no retry/log spam.
		writes.length = 0;
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(writes).to.deep.equal([]);
	});

	it('recovers from failsafe when the source delivers again', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000);
		mock.setGridSource(Date.now() - 300000);
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(mock.states['controller.status']).to.equal('failsafe');
		writes.length = 0;
		await ctrl.onGridPower(500);
		expect(mock.states['controller.status']).to.equal('ok');
		expect(writes.length).to.equal(1);
	});
});
