/**
 * Unit tests for the multi-head controller (mocked adapter + hooks, no hardware).
 */

import { expect } from 'chai';
import type { ControllerConfig, ControllerHooks } from './controller';
import { ADAPTIVE_DEAD_BAND_W, adaptiveTierFor, MultiHeadController } from './controller';
import type { HeadState } from './split';

/** Records every state write so tests can assert on telemetry. */
interface MockAdapter {
	adapter: ioBroker.Adapter;
	states: Record<string, unknown>;
	/** Everything logged at warn level, so tests can assert on debouncing. */
	warnings: string[];
	/** Everything logged at info level, so tests can assert on what stays visible. */
	infos: string[];
	/** Makes writes to this state id block until releaseStates() is called. */
	blockState(id: string): void;
	/** Lets every blocked state write through. */
	releaseStates(): void;
	/** Intervals the controller armed, so the watchdog's existence can be asserted. */
	intervals: number[];
}

function mockAdapter(): MockAdapter {
	const states: Record<string, unknown> = {};
	const warnings: string[] = [];
	const infos: string[] = [];
	const blocked = new Set<string>();
	const intervals: number[] = [];
	let waiters: (() => void)[] = [];
	const adapter = {
		log: {
			info: (m: string) => infos.push(m),
			warn: (m: string) => warnings.push(m),
			debug: () => undefined,
			error: () => undefined,
		},
		setStateChangedAsync: async (id: string, val: unknown) => {
			if (blocked.has(id)) {
				await new Promise<void>(resolve => waiters.push(resolve));
			}
			states[id] = val;
		},

		setInterval: (_cb: () => void, ms: number) => {
			intervals.push(ms);
			return undefined;
		},
		clearInterval: () => undefined,
	} as unknown as ioBroker.Adapter;
	return {
		adapter,
		states,
		warnings,
		infos,
		intervals,
		blockState: (id: string) => blocked.add(id),
		releaseStates: () => {
			blocked.clear();
			const pending = waiters;
			waiters = [];
			for (const r of pending) {
				r();
			}
		},
	};
}

interface MockHooks {
	hooks: ControllerHooks;
	writes: { index: number; gs: number }[];
	/** Every IS limit written, in order. */
	isWrites: { index: number; is: number }[];
	/** Head indexes whose writeGs should throw. */
	failing: Set<number>;
	/** Head indexes whose writeIs should throw. */
	failingIs: Set<number>;
	/**
	 * Head indexes whose writeGs blocks until released. Without this a test cannot
	 * distinguish concurrent from sequential dispatch: instantly-resolved promises
	 * look identical either way.
	 */
	blocking: Set<number>;
	/** Head indexes currently parked inside writeGs. */
	inFlight: Set<number>;
	/** Releases every parked write. */
	release: () => void;
	/**
	 * Every GS write *attempt*, successful or not.
	 *
	 * `writes` only records what got through, so a test that makes writes fail and
	 * then counts `writes` counts zero however the code behaves — it passes whether
	 * the rate limit exists or not. Anything about throttling has to assert on these.
	 */
	gsAttempts: { index: number; gs: number }[];
	/** Every IS write attempt, successful or not, for the same reason. */
	isAttempts: { index: number; is: number }[];
}

function mockHooks(heads: HeadState[]): MockHooks {
	const writes: { index: number; gs: number }[] = [];
	const isWrites: { index: number; is: number }[] = [];
	const failing = new Set<number>();
	const failingIs = new Set<number>();
	const blocking = new Set<number>();
	const inFlight = new Set<number>();
	const gsAttempts: { index: number; gs: number }[] = [];
	const isAttempts: { index: number; is: number }[] = [];
	let waiters: (() => void)[] = [];
	return {
		writes,
		isWrites,
		failing,
		failingIs,
		blocking,
		inFlight,
		gsAttempts,
		isAttempts,
		release: () => {
			const pending = waiters;
			waiters = [];
			for (const r of pending) {
				r();
			}
		},
		hooks: {
			getHeads: () => heads,
			writeGs: async (index, gs) => {
				gsAttempts.push({ index, gs });
				if (failing.has(index)) {
					throw new Error('write failed');
				}
				if (blocking.has(index)) {
					inFlight.add(index);
					await new Promise<void>(resolve => waiters.push(resolve));
					inFlight.delete(index);
				}
				writes.push({ index, gs });
			},
			reflectGs: () => Promise.resolve(),
			writeIs: (index, is) => {
				isAttempts.push({ index, is });
				if (failingIs.has(index)) {
					return Promise.reject(new Error('IS write failed'));
				}
				isWrites.push({ index, is });
				return Promise.resolve();
			},
			reflectIs: () => Promise.resolve(),
		},
	};
}

/**
 * Build a head with sensible defaults (PRO: 2400 W, half full, online).
 *
 * @param partial Overrides merged onto the defaults (index is required).
 */
function head(partial: Partial<HeadState> & { index: number }): HeadState {
	return {
		online: true,
		controllable: true,
		gp: 0,
		soc: 50,
		socMin: 10,
		socMax: 100,
		maxPower: 2400,
		lp: 0,
		pv: 0,
		socHysteresisDischarge: 5,
		socHysteresisCharge: 5,
		...partial,
	};
}

/**
 * Monotonically advancing sample timestamps.
 *
 * The controller discards meter samples that are not newer than its last write, so a
 * test feeding several readings in the same millisecond would have all but the first
 * rejected — an ordering a real meter never produces. Each call moves one second on,
 * which is what an actual meter interval looks like.
 */
/**
 * Backdates the controller's last write, as if it had happened `ms` ago.
 *
 * @param ctrl the controller under test
 * @param ms how long ago the last write cycle ran
 */
function ageWrite(ctrl: MultiHeadController, ms: number): void {
	const c = ctrl as unknown as { lastWriteTime: number; lastWriteDoneTs: number };
	const t = Date.now() - ms;
	// The controller keeps these apart (attempt drives the rate limit, completion the
	// freshness gate) but in reality they are milliseconds apart, so tests age both.
	c.lastWriteTime = t;
	c.lastWriteDoneTs = t;
}

/**
 * Backdates the controller's last usable sample, which is what the watchdog measures.
 *
 * @param ctrl the controller under test
 * @param sec how many seconds ago the last usable sample arrived
 */
function ageSource(ctrl: MultiHeadController, sec: number): void {
	(ctrl as unknown as { lastValidSampleTs: number }).lastValidSampleTs = Date.now() - sec * 1000;
}

/** Lets queued microtasks and immediates run, so parked writes reach their await. */
function tick(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

function sampleClock(): () => number {
	let t = Date.now();
	return () => (t += 1000);
}

/**
 * Default controller config for tests: no throttling, no dead bands.
 *
 * @param partial Overrides merged onto the defaults.
 */
function cfg(partial: Partial<ControllerConfig> = {}): ControllerConfig {
	return {
		adaptive: false,
		targetW: 0,
		gain: 1,
		deadBandW: 0,
		maxStepW: 0,
		minIntervalMs: 0,
		writeDeadBandW: 0,
		meterStabilizationMs: 0,
		controlIs: false,
		isWriteDeadBandW: 10,
		inverted: false,
		warnSec: 30,
		failsafeSec: 180,
		...partial,
	};
}

describe('adaptiveTierFor', () => {
	it('selects the manufacturer tiers by error magnitude', () => {
		expect(adaptiveTierFor(0)).to.deep.include({ intervalMs: 7000, maxStepW: 20 });
		expect(adaptiveTierFor(29)).to.deep.include({ intervalMs: 7000, maxStepW: 20 });
		expect(adaptiveTierFor(30)).to.deep.include({ intervalMs: 2500, maxStepW: 120 });
		expect(adaptiveTierFor(149)).to.deep.include({ intervalMs: 2500, maxStepW: 120 });
		expect(adaptiveTierFor(150)).to.deep.include({ intervalMs: 1000, maxStepW: 450 });
		expect(adaptiveTierFor(5000)).to.deep.include({ intervalMs: 1000, maxStepW: 450 });
	});
});

describe('MultiHeadController (adaptive mode)', () => {
	it('corrects a small deviation with the small-tier step cap', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ adaptive: true }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(25, Date.now() + 1000); // small tier: full error wanted, capped at 20 W step
		expect(writes).to.deep.equal([{ index: 1, gs: 20 }]);
	});

	it('ignores errors inside the fixed adaptive dead band', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ adaptive: true }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(ADAPTIVE_DEAD_BAND_W - 1, Date.now() + 1000);
		expect(writes).to.deep.equal([]);
	});

	it('reacts immediately to a large load step with the large-tier cap', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ adaptive: true }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000, Date.now() + 1000); // large tier: capped at 450 W movement
		expect(writes).to.deep.equal([{ index: 1, gs: 450 }]);
	});

	it('throttles small corrections by the 7 s tier interval but lets a load step through', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ adaptive: true }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(25, Date.now() + 1000); // writes 20, sets lastWriteTime
		await ctrl.onGridPower(25, Date.now() + 1000); // small tier: inside the 7 s interval → skipped
		expect(writes).to.deep.equal([{ index: 1, gs: 20 }]);
		// Pretend 1.5 s passed: still inside the small tier interval, but a big error
		// selects the large tier (1 s) and passes.
		ageWrite(ctrl, 1500);
		await ctrl.onGridPower(500, Date.now() + 1000);
		expect(writes.length).to.equal(2);
		expect(writes[1].gs).to.equal(20 + 450); // large-tier step from the current base
	});

	it('regulates towards the target grid power in adaptive mode too', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, targetW: 100 }),
		);
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(120, Date.now() + 1000); // 20 W above the 100 W draw target → small tier
		expect(writes).to.deep.equal([{ index: 1, gs: 20 }]);
	});
});

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
		await ctrl.onGridPower(1000, Date.now() + 1000); // draw 1000 W → discharge 1000 W total
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
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // base 0 → 500
		await ctrl.onGridPower(500, at()); // base 500 → 750
		await ctrl.onGridPower(250, at()); // base 750 → 875
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
		const at = sampleClock();
		await ctrl.onGridPower(300, at()); // 200 W above the 100 W draw target → discharge 200 W
		expect(writes).to.deep.equal([{ index: 1, gs: 200 }]);
		await ctrl.onGridPower(100, at()); // exactly on target → no change
		expect(writes.length).to.equal(1);
	});

	it('discards a meter sample taken before the last write', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		await ctrl.onGridPower(1000, at());
		expect(writes.length).to.equal(1);
		// A reading from before that write still describes the pre-write state; acting on
		// it would apply the same correction twice.
		const stale = (ctrl as unknown as { lastWriteDoneTs: number }).lastWriteDoneTs - 5000;
		await ctrl.onGridPower(1000, stale);
		expect(writes.length).to.equal(1);
	});

	it('honours the meter settling time on top of the write timestamp', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ meterStabilizationMs: 3000 }),
		);
		await ctrl.start();
		writes.length = 0;
		const internal = ctrl as unknown as { lastWriteDoneTs: number };
		await ctrl.onGridPower(1000, internal.lastWriteDoneTs + 3001);
		expect(writes.length).to.equal(1);
		// Newer than the write, but inside the settling window → still not usable.
		await ctrl.onGridPower(1000, internal.lastWriteDoneTs + 2000);
		expect(writes.length).to.equal(1);
		// Past the settling window → accepted.
		await ctrl.onGridPower(1000, internal.lastWriteDoneTs + 3001);
		expect(writes.length).to.equal(2);
	});

	it('regulates despite stale timestamps once the last write ages out', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000, sampleClock()());
		expect(writes.length).to.equal(1);
		// A source whose clock runs behind ours would look stale forever — the freshness
		// gate must not be able to freeze the loop permanently.
		ageWrite(ctrl, 31000);
		await ctrl.onGridPower(500, Date.now() - 60000);
		expect(writes.length).to.equal(2);
	});

	it('writes all heads concurrently, isolating a failing one', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		failing.add(2); // head 2 is unreachable
		await ctrl.onGridPower(3000, sampleClock()());
		// Heads 1 and 3 still get their share; head 2's failure neither aborts nor
		// reorders the others.
		expect(writes.map(w => w.index).sort()).to.deep.equal([1, 3]);
	});

	it('actually dispatches heads in parallel, not one after another', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks, writes, blocking, inFlight, release } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		// Park every head inside its write. Sequential dispatch would only ever have
		// one parked at a time; concurrent dispatch has all three.
		blocking.add(1);
		blocking.add(2);
		blocking.add(3);
		const cycle = ctrl.onGridPower(3000, sampleClock()());
		await tick();
		expect([...inFlight].sort()).to.deep.equal([1, 2, 3]);
		release();
		await cycle;
		expect(writes.length).to.equal(3);
	});

	it('a slow head does not delay the others past the cycle', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		const { hooks, writes, blocking, inFlight, release } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		blocking.add(1); // head 1 is slow
		const cycle = ctrl.onGridPower(2000, sampleClock()());
		await tick();
		// Head 2 is already done while head 1 is still parked.
		expect(writes.map(w => w.index)).to.deep.equal([2]);
		expect([...inFlight]).to.deep.equal([1]);
		release();
		await cycle;
		expect(writes.map(w => w.index).sort()).to.deep.equal([1, 2]);
	});

	it('keeps the failsafe neutralisation even after anti-windup adjusted the base', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()()); // commands GS=1000
		const internal = ctrl as unknown as { lastWriteTime: number };
		internal.lastWriteTime = Date.now() - 20000;
		// Device internally limits and reports 0 W. This must move the feed-forward
		// base only — the command record still says 1000, so the head is NOT neutral.
		ctrl.noteReportedGp(1, 0);
		writes.length = 0;
		ageSource(ctrl, 300);
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
	});

	it('does not mistake an internally limiting device for a foreign GS writer', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()());
		const internal = ctrl as unknown as { lastWriteTime: number };
		internal.lastWriteTime = Date.now() - 20000;
		ctrl.noteReportedGp(1, 0); // anti-windup moves the base
		ctrl.noteReportedGs(1, 1000); // device echoes exactly what we commanded
		expect(mock.warnings.filter(w => w.includes('something else is writing GS'))).to.deep.equal([]);
	});

	it('does not start a second cycle while one is parked in the telemetry write', async () => {
		// The window this guards is the await on controller.totalTarget, *before* any
		// device write. Blocking at the device write instead would leave that window
		// untested — a lock taken after the telemetry await would pass such a test.
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		mock.blockState('controller.totalTarget');
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ maxStepW: 450 }));
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		const first = ctrl.onGridPower(1000, at());
		await tick();
		// Second event arrives while the first cycle waits on its telemetry write.
		await ctrl.onGridPower(-1000, at());
		mock.releaseStates();
		await first;
		await tick();
		// One cycle, one setpoint — not two conflicting ones from the same stale base.
		expect(writes).to.deep.equal([{ index: 1, gs: 450 }]);
	});

	it('arms the tier interval even when every write failed', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		failing.add(1);
		const internal = ctrl as unknown as { lastWriteTime: number };
		internal.lastWriteTime = 0;
		await ctrl.onGridPower(1000, sampleClock()());
		// Without this the rate limit would never engage on a head that keeps timing out,
		// and every source value would trigger another immediate retry.
		expect(internal.lastWriteTime).to.be.greaterThan(0);
	});

	it('warns once when something else writes GS', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()());
		const internal = ctrl as unknown as { lastWriteTime: number };
		// Age the write out of the settle window so the echo is trustworthy.
		internal.lastWriteTime = Date.now() - 20000;
		ctrl.noteReportedGs(1, 1000); // commanded was 1000 → matches, silent
		expect(mock.warnings).to.deep.equal([]);
		ctrl.noteReportedGs(1, 250); // foreign write
		expect(mock.warnings.length).to.equal(1);
		expect(mock.warnings[0]).to.contain('something else is writing GS');
		ctrl.noteReportedGs(1, 250); // debounced — not logged again
		expect(mock.warnings.length).to.equal(1);
	});

	it('stays silent about GS right after its own write', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()());
		// A poll overlapping our own fresh write still carries the old echo — not foreign.
		ctrl.noteReportedGs(1, 0);
		expect(mock.warnings).to.deep.equal([]);
	});

	it('leaves IS alone unless it is switched on', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, isWrites } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()());
		expect(isWrites).to.deep.equal([]);
	});

	it('follows GS with an IS limit when enabled', async () => {
		const heads = [head({ index: 1, lp: 200 })];
		const { hooks, isWrites } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		isWrites.length = 0;
		await ctrl.onGridPower(1000, sampleClock()()); // GS 1000 + 200 W local load
		expect(isWrites).to.deep.equal([{ index: 1, is: 1200 }]);
	});

	it('releases IS to the head maximum on failsafe', async () => {
		const heads = [head({ index: 1, maxPower: 800 })];
		const { hooks, isWrites } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ controlIs: true }));
		await ctrl.start();
		await ctrl.onGridPower(500, sampleClock()());
		isWrites.length = 0;
		ageSource(ctrl, 300);
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		// Nothing maintains the limit while the controller is not regulating.
		expect(isWrites).to.deep.equal([{ index: 1, is: 800 }]);
	});

	it('ages the watchdog on unusable samples instead of staying healthy', async () => {
		// The source keeps publishing, but the loop rejects everything it sends (the
		// adapter drops ack=false before we are called). The watchdog must not read
		// those as signs of life.
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		await ctrl.start();
		await ctrl.onGridPower(1000, sampleClock()()); // one good sample -> GS=1000
		writes.length = 0;
		// Age the last usable sample past the failsafe budget; nothing usable since.
		(ctrl as unknown as { lastValidSampleTs: number }).lastValidSampleTs = Date.now() - 120000;
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(mock.states['controller.status']).to.equal('failsafe');
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
	});

	it('neutralises the heads when the source never delivered anything', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		failing.add(1); // the start neutralisation fails: head unreachable at boot
		await ctrl.start();
		failing.delete(1); // head is back by the time the watchdog fires
		writes.length = 0;
		(ctrl as unknown as { startedAt: number }).startedAt = Date.now() - 120000;
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		// It must not assume start() succeeded — the head may still hold an old setpoint.
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
		expect(mock.states['controller.status']).to.equal('failsafe');
	});

	it('starts no new cycle or write once stopped', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes, blocking, release } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		blocking.add(1);
		const at = sampleClock();
		const inFlightCycle = ctrl.onGridPower(1000, at()); // parks inside the write
		await tick();
		ctrl.stop();
		release();
		await inFlightCycle;
		// The already-dispatched request cannot be recalled and does land.
		expect(writes).to.deep.equal([{ index: 1, gs: 1000 }]);
		// But nothing new may follow it.
		await ctrl.onGridPower(-1000, at());
		expect(writes.length).to.equal(1);
	});

	it('does not begin the IS write once stopped after the GS write', async () => {
		// The GS writes of a cycle all start in the same tick, so stop() can never land
		// between them. The IS block is different: it runs after awaiting the GS writes,
		// which is exactly where a shutdown can fall — and an IS limit arriving after the
		// shutdown release would leave the inverter throttled with nobody to lift it.
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, writes, isWrites, blocking, release } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		writes.length = 0;
		isWrites.length = 0;
		blocking.add(1);
		const cycle = ctrl.onGridPower(1000, sampleClock()());
		await tick();
		ctrl.stop(); // shutdown arrives while the GS write is in flight
		release();
		await cycle;
		await tick();
		expect(writes.length).to.equal(1); // the dispatched GS write still lands
		expect(isWrites).to.deep.equal([]); // but no IS limit follows it
	});

	it('clamps a head that hit its SoC floor even inside the grid dead band', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ deadBandW: 50, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // discharging at 500 W
		expect(writes[writes.length - 1].gs).to.equal(500);
		writes.length = 0;
		// Battery hits its floor while the house happens to sit on target. The grid error
		// is inside the dead band, but leaving the head discharging would be wrong.
		heads[0].soc = 10;
		heads[0].socMin = 10;
		ageWrite(ctrl, 5000);
		await ctrl.onGridPower(10, at()); // |error| = 10 < 50 W dead band
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
	});

	it('updates IS inside the dead band when the load changes', async () => {
		const heads = [head({ index: 1, lp: 0 })];
		const { hooks, isWrites } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ deadBandW: 50, controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		isWrites.length = 0;
		heads[0].lp = 400; // a local load appears; grid error stays inside the dead band
		ageWrite(ctrl, 5000);
		await ctrl.onGridPower(10, at());
		expect(isWrites).to.deep.equal([{ index: 1, is: 900 }]); // 500 GS + 400 load
	});

	it('dates the freshness gate from the end of the write, not its start', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes, blocking, release } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		blocking.add(1);
		const cycleStart = Date.now();
		const cycle = ctrl.onGridPower(1000, cycleStart + 1); // write parks in the queue
		await tick();
		await new Promise(r => setTimeout(r, 30)); // the write sits queued for a while
		release();
		await cycle;
		expect(writes.length).to.equal(1);
		// A sample taken during that queued wait describes the pre-write device state.
		// Dated from the cycle start it would look fresh; dated from completion it does not.
		await ctrl.onGridPower(1000, cycleStart + 10);
		expect(writes.length).to.equal(1);
	});

	it('still corrects a small deviation when three heads share the step', async () => {
		// 20 W small-tier step across three heads is under 7 W each — below the 10 W
		// default per-head dead band. The aggregate move has to carry it through.
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, writeDeadBandW: 10 }),
		);
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(-25, sampleClock()());
		expect(writes.length).to.equal(3);
		expect(writes.every(w => w.gs === -7)).to.equal(true);
	});

	it('clears the setpoint of a head that lost its SoC data', async () => {
		// The head still answers, so nothing else notices: the meter is healthy, the
		// watchdog is content, info.online stays true. Without this it would keep
		// executing its last setpoint indefinitely.
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // commands GS=1000
		writes.length = 0;
		heads[0].controllable = false;
		await ctrl.onGridPower(1000, at());
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
		expect(mock.warnings.some(w => w.includes('no usable SoC data'))).to.equal(true);
	});

	it('warns only once per episode of missing SoC data', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at());
		heads[0].controllable = false;
		await ctrl.onGridPower(1000, at());
		await ctrl.onGridPower(1000, at());
		await ctrl.onGridPower(1000, at());
		expect(mock.warnings.filter(w => w.includes('no usable SoC data')).length).to.equal(1);
	});

	it('goes to failsafe when no head is regulatable any more', async () => {
		// The source watchdog cannot see this — the meter keeps delivering, there is just
		// nothing left able to act on it.
		const heads = [head({ index: 1, controllable: false })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // starts the episode
		(ctrl as unknown as { noControllableSince: number }).noControllableSince = Date.now() - 120000;
		await ctrl.onGridPower(1000, at());
		expect(mock.states['controller.status']).to.equal('failsafe');
		expect(mock.warnings.some(w => w.includes('regulatable'))).to.equal(true);
	});

	it('does not let a healthy meter clear the no-head failsafe', async () => {
		// The two failsafes mean different things: the source one is rightly cleared by
		// every usable sample, the head one says nothing about the meter. Sharing a flag
		// made each reading clear and re-raise it — status flapping and one warning per
		// sample, forever.
		const heads = [head({ index: 1, controllable: false })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		(ctrl as unknown as { noControllableSince: number }).noControllableSince = Date.now() - 120000;
		for (let i = 0; i < 6; i++) {
			await ctrl.onGridPower(500, at()); // meter is perfectly healthy throughout
		}
		expect(mock.states['controller.status']).to.equal('failsafe');
		expect(mock.warnings.filter(w => w.includes('regulatable')).length).to.equal(1);
	});

	it('returns to ok once a head is regulatable again', async () => {
		const heads = [head({ index: 1, controllable: false })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		(ctrl as unknown as { noControllableSince: number }).noControllableSince = Date.now() - 120000;
		await ctrl.onGridPower(500, at());
		expect(mock.states['controller.status']).to.equal('failsafe');
		heads[0].controllable = true; // the head starts delivering SoC again
		await ctrl.onGridPower(500, at());
		expect(mock.states['controller.status']).to.equal('ok');
	});

	it('keeps the discharge saturation memory across a charge', async () => {
		// One shared memory loses this: a head that hit its discharge floor and is then
		// charged briefly has that record cleared, so the discharge hysteresis no longer
		// applies and the loop commands power the device still refuses.
		const heads = [head({ index: 1, soc: 5, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // discharge wanted, head is empty
		const internal = ctrl as unknown as {
			saturatedDischarge: Set<number>;
			saturatedCharge: Set<number>;
		};
		expect([...internal.saturatedDischarge]).to.deep.equal([1]);
		heads[0].soc = 6;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(-800, at()); // charging must not erase the discharge record
		expect([...internal.saturatedDischarge]).to.deep.equal([1]);
		expect([...internal.saturatedCharge]).to.deep.equal([]);
	});

	it('does not record a head as saturated when its share merely rounded away', async () => {
		// Deriving saturation from `gs === 0` also catches heads that are simply too
		// small a share to matter, which would then be held back by a hysteresis band
		// they never hit.
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ writeDeadBandW: 0 }));
		await ctrl.start();
		await ctrl.onGridPower(1, sampleClock()()); // 1 W over three heads: rounds to 0
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };
		expect([...internal.saturatedDischarge]).to.deep.equal([]);
	});

	it('records responsibility before the write, not after it', async () => {
		// A request that goes out may be applied even when its response is lost. Marking
		// only on success would leave a head that is carrying a setpoint looking untouched.
		const heads = [head({ index: 1 })];
		const { hooks, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		failing.add(1); // the device applies it, the response is lost
		await ctrl.onGridPower(1000, sampleClock()());
		expect([...(ctrl as unknown as { everCommanded: Set<number> }).everCommanded]).to.deep.equal([1]);
	});

	it('keeps the status on failsafe when a source warning arrives', async () => {
		// Seven separate status writers were how a source warning could overwrite an
		// active head failsafe and never be undone.
		const heads = [head({ index: 1, controllable: false })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60, warnSec: 10 }));
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		(ctrl as unknown as { noControllableSince: number }).noControllableSince = Date.now() - 120000;
		await ctrl.onGridPower(500, at());
		expect(mock.states['controller.status']).to.equal('failsafe');
		// Source goes quiet long enough to warn, but not long enough to fail safe.
		ageSource(ctrl, 20);
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(mock.states['controller.status'], 'a warning must not outrank a failsafe').to.equal('failsafe');
	});

	it('releases IS for an uncontrollable head even when GS is already zero', async () => {
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, isWrites } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // sets a throttled IS
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(-1000, at()); // drives GS back to zero
		isWrites.length = 0;
		heads[0].controllable = false;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(0, at());
		expect(
			isWrites.some(w => w.is === 2400),
			'IS must be handed back',
		).to.equal(true);
	});

	it('lets IS follow GS on every cycle', async () => {
		// IS caps what the inverter may put out. Throttling successful IS writes leaves
		// the device limited to an old, much smaller value while GS keeps rising — the
		// option becomes worse than useless.
		const heads = [head({ index: 1 })];
		const { hooks, writes, isWrites } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			// minIntervalMs is set on purpose: the adaptive mode does not use it for GS,
			// and the IS path must not quietly adopt it either.
			cfg({ adaptive: true, controlIs: true, writeDeadBandW: 1, minIntervalMs: 5000 }),
		);
		await ctrl.start();
		writes.length = 0;
		isWrites.length = 0;
		const at = sampleClock();
		for (let i = 0; i < 5; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(1000, at());
		}
		expect(isWrites.map(w => w.is)).to.deep.equal(writes.map(w => w.gs));
	});

	it('backs off IS only after a failure, and recovers', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, isWrites, failingIs } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		isWrites.length = 0;
		failingIs.add(1);
		const at = sampleClock();
		for (let i = 0; i < 4; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(500 + i * 100, at());
		}
		expect(isWrites.length, 'failures are throttled').to.equal(0);
		failingIs.clear();
		(ctrl as unknown as { lastIsFailure: Map<number, number> }).lastIsFailure.set(1, Date.now() - 20000);
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(1000, at());
		expect(isWrites.length, 'and it recovers afterwards').to.equal(1);
	});

	it('keeps GS and IS failure bookkeeping apart', async () => {
		// A failed IS write must not make the next GS echo look like a recovery from a
		// failed GS write — that would silently adopt a value that was never in doubt.
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, failingIs } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		failingIs.add(1);
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // GS succeeds, IS fails
		ageWrite(ctrl, 20000);
		// The device reports a GS we never commanded: that is a foreign writer, and the
		// failed IS write must not turn it into a silent adoption.
		ctrl.noteReportedGs(1, 250);
		expect((ctrl as unknown as { lastGs: Map<number, number> }).lastGs.get(1)).to.equal(1000);
		void mock;
	});

	it('throttles repeated neutralisation of an uncontrollable head', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at());
		writes.length = 0;
		heads[0].controllable = false;
		failing.add(1); // the neutralisation keeps failing
		let attempts = 0;
		const original = hooks.writeGs;
		hooks.writeGs = (index, gs) => {
			attempts++;
			return original(index, gs);
		};
		for (let i = 0; i < 5; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(1000, at());
		}
		// Without the back-off this fires on every source value, inside the cycle lock —
		// five attempts instead of one.
		expect(attempts, 'neutralisation must be throttled').to.equal(1);
		expect(writes.length).to.equal(0); // and all of them failed
	});

	it('clears an inherited setpoint when the head stops delivering SoC data', async () => {
		// A previous run left a setpoint on this head. This controller's own GS=0 at
		// start failed, so it never recorded a write of its own — and then the head
		// stops delivering SoC. Without the inherited responsibility nothing would ever
		// clear what the device is still executing.
		const heads = [head({ index: 1 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		ctrl.assumeCommanded([1]); // inherited from info.gsOwned
		failing.add(1); // the initial neutralisation fails
		await ctrl.start();
		failing.delete(1);
		writes.length = 0;
		heads[0].controllable = false; // reachable, but no usable SoC any more
		await ctrl.onGridPower(500, sampleClock()());
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
	});

	it('throttles a failing IS release instead of retrying on every sample', async () => {
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, isWrites, failingIs } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // sets a throttled IS
		isWrites.length = 0;
		let attempts = 0;
		const originalIs = hooks.writeIs;
		hooks.writeIs = (index, is) => {
			attempts++;
			return originalIs(index, is);
		};
		failingIs.add(1);
		heads[0].controllable = false; // triggers the release path on every cycle
		for (let i = 0; i < 6; i++) {
			ageWrite(ctrl, 10000);
			(ctrl as unknown as { lastUncontrollableTry: Map<number, number> }).lastUncontrollableTry.clear();
			await ctrl.onGridPower(500, at());
		}
		// Releases bypass the normal rate limit on purpose, but a failing one must not
		// be retried on every single source value.
		expect(attempts).to.be.lessThan(4);
	});

	it('writes a safety clamp to zero even below the write dead band', async () => {
		// After a large correction the remaining setpoint can be smaller than the dead
		// band. Hitting the SoC limit then still has to reach the device.
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ writeDeadBandW: 10, deadBandW: 0 }),
		);
		await ctrl.start();
		const at = sampleClock();
		// A small setpoint is only reachable via a larger correction — 0 -> 5 would be
		// inside the dead band itself. 0 -> 100 -> 5 is an ordinary sequence.
		await ctrl.onGridPower(100, at());
		expect(writes[writes.length - 1].gs).to.equal(100);
		ageWrite(ctrl, 5000);
		// The loop integrates: base 100 plus an error of -95 lands on 5.
		await ctrl.onGridPower(-95, at());
		expect(writes[writes.length - 1].gs).to.equal(5);
		writes.length = 0;
		heads[0].soc = 10;
		heads[0].socMin = 10; // discharge floor reached
		ageWrite(ctrl, 5000);
		await ctrl.onGridPower(0, at()); // house on target, so only the clamp acts
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
	});

	it('retries a small three-head step after every write failed', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, writeDeadBandW: 10 }),
		);
		await ctrl.start();
		writes.length = 0;
		failing.add(1);
		failing.add(2);
		failing.add(3);
		const at = sampleClock();
		await ctrl.onGridPower(-25, at()); // all three fail
		expect(writes).to.deep.equal([]);
		failing.clear();
		ageWrite(ctrl, 10000);
		// The aggregate move must not count as done just because it was attempted —
		// otherwise every per-head delta is under the dead band again and it never retries.
		await ctrl.onGridPower(-25, at());
		expect(writes.length).to.equal(3);
	});

	it('rate-limits repeated IS failures instead of retrying on every sample', async () => {
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, isAttempts, failingIs } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1, minIntervalMs: 5000 }),
		);
		await ctrl.start();
		failingIs.add(1);
		isAttempts.length = 0;
		const at = sampleClock();
		for (let i = 0; i < 5; i++) {
			ageWrite(ctrl, 10000); // clear the GS rate limit each time
			await ctrl.onGridPower(500 + i, at());
		}
		// Attempts, not landed writes: every write here fails, so `isWrites` would stay
		// at zero whether the back-off exists or not.
		expect(isAttempts.length).to.be.lessThan(3);
		expect(isAttempts.length, 'but it must try at least once').to.be.greaterThan(0);
	});

	it('adopts the echoed GS after a failed write instead of blaming a foreign writer', async () => {
		// A timeout is not proof the device ignored the write — the request may have
		// landed and only the response been lost.
		const heads = [head({ index: 1 })];
		const { hooks, failing } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		failing.add(1);
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // write fails, lastGs stays at 0
		ageWrite(ctrl, 20000);
		ctrl.noteReportedGs(1, 1000); // the device did apply it after all
		expect(mock.warnings.filter(w => w.includes('something else is writing GS'))).to.deep.equal([]);
		expect((ctrl as unknown as { lastGs: Map<number, number> }).lastGs.get(1)).to.equal(1000);
	});

	it('retries a three-head step when only some heads were written', async () => {
		// A partial success is not progress: the total demonstrably did not move, so the
		// heads that failed still need their correction on the next cycle.
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, writeDeadBandW: 10 }),
		);
		await ctrl.start();
		writes.length = 0;
		failing.add(2);
		failing.add(3); // head 1 succeeds, the other two fail
		const at = sampleClock();
		await ctrl.onGridPower(-25, at());
		expect(writes.map(w => w.index)).to.deep.equal([1]);
		failing.clear();
		writes.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(-25, at());
		expect(writes.map(w => w.index).sort()).to.deep.equal([1, 2, 3]);
	});

	it('ages the freshness gate after a safety neutralisation', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 60 }));
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(1000, at());
		// Backdate it so the assertion cannot pass by both happening in the same
		// millisecond — the point is that the failsafe re-dates it at all.
		ageWrite(ctrl, 60000);
		const beforeFailsafe = (ctrl as unknown as { lastWriteDoneTs: number }).lastWriteDoneTs;
		ageSource(ctrl, 300);
		writes.length = 0;
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(writes).to.deep.equal([{ index: 1, gs: 0 }]);
		// The neutralisation moved real power, so a sample from before it is not usable.
		expect((ctrl as unknown as { lastWriteDoneTs: number }).lastWriteDoneTs).to.be.greaterThan(beforeFailsafe);
	});

	it('ages the freshness gate on the initial neutralisation too', async () => {
		// The device may already be running an old setpoint — that is exactly why it is
		// neutralised at start. A reading taken under that old setpoint would send the
		// first correction in the wrong direction, so it has to be rejected.
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		const before = Date.now();
		await ctrl.start();
		expect((ctrl as unknown as { lastWriteDoneTs: number }).lastWriteDoneTs).to.be.at.least(before);
		writes.length = 0;
		await ctrl.onGridPower(1000, before - 5000); // taken under the old setpoint
		expect(writes).to.deep.equal([]);
		await ctrl.onGridPower(1000, Date.now() + 1000); // taken after the neutralisation
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
		const at = sampleClock();
		await ctrl.onGridPower(1000, at()); // raw target 1000, capped to base 0 + 200
		await ctrl.onGridPower(800, at()); // raw target 200+800=1000, capped to 200 + 200
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
		await ctrl.onGridPower(1000, Date.now() + 1000);
		expect(writes).to.deep.equal([{ index: 1, gs: 1000 }]);
	});

	it('respects an explicit dead band of zero and a configured one', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ deadBandW: 50 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(30, Date.now() + 1000); // inside the grid dead band → no write
		expect(writes).to.deep.equal([]);
		await ctrl.onGridPower(80, Date.now() + 1000); // outside → write
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
		await ctrl.onGridPower(100, Date.now() + 1000); // target 10, change 10 < 50 → skipped
		expect(writes).to.deep.equal([]);
		await ctrl.onGridPower(1000, Date.now() + 1000); // target 100, change 100 ≥ 50 → written
		expect(writes).to.deep.equal([{ index: 1, gs: 100 }]);
	});

	it('throttles by the minimum write interval', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg({ minIntervalMs: 60000 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(1000, Date.now() + 1000); // first write allowed
		await ctrl.onGridPower(2000, Date.now() + 1000); // second event inside the interval → throttled
		expect(writes).to.deep.equal([{ index: 1, gs: 1000 }]);
	});

	it('keeps writing the remaining heads when one write fails', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		const { hooks, writes, failing } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		failing.add(1);
		await ctrl.onGridPower(1000, Date.now() + 1000);
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
		await ctrl.onGridPower(1000, Date.now() + 1000);
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
		await ctrl.onGridPower(1000, Date.now() + 1000); // gain 0 → target = base = polled gp = 700
		expect(writes).to.deep.equal([{ index: 1, gs: 700 }]);
	});

	it('goes to failsafe (GS=0 on online heads) when the grid source is stale', async () => {
		const heads = [head({ index: 1 }), head({ index: 2, online: false })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 180 }));
		await ctrl.start();
		await ctrl.onGridPower(1000, Date.now() + 1000); // establishes everSeenSource and a non-zero GS
		writes.length = 0;
		ageSource(ctrl, 300); // 300 s since the last usable sample → beyond failsafe
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
		const at = sampleClock();
		await ctrl.onGridPower(1000, at());
		ageSource(ctrl, 300);
		await (ctrl as unknown as { watchdogTick(): Promise<void> }).watchdogTick();
		expect(mock.states['controller.status']).to.equal('failsafe');
		writes.length = 0;
		await ctrl.onGridPower(500, at());
		expect(mock.states['controller.status']).to.equal('ok');
		expect(writes.length).to.equal(1);
	});

	it('goes to failsafe when the source never delivered a single value', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ failsafeSec: 180 }));
		await ctrl.start();
		const internal = ctrl as unknown as { startedAt: number; watchdogTick(): Promise<void> };

		// Inside the grace period the loop is simply still waiting — stay quiet.
		internal.startedAt = Date.now() - 60000;
		await internal.watchdogTick();
		expect(mock.states['controller.status']).to.equal('ok');

		internal.startedAt = Date.now() - 200000;
		await internal.watchdogTick();
		expect(mock.states['controller.status']).to.equal('failsafe');
	});
});

describe('MultiHeadController telemetry', () => {
	it('mirrors the grid power the way the loop sees it, after inversion', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ inverted: true }));
		await ctrl.start();
		// Source reports +900 with the opposite convention → really a 900 W export.
		await ctrl.onGridPower(900, Date.now() + 1000);
		expect(mock.states['controller.gridPower']).to.equal(-900);
	});

	it('mirrors the grid power even while the dead band suppresses any write', async () => {
		const heads = [head({ index: 1 })];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ deadBandW: 100 }));
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(20, Date.now() + 1000);
		expect(writes).to.deep.equal([]);
		expect(mock.states['controller.gridPower']).to.equal(20);
	});

	it('publishes the total setpoint before the split', async () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(-1000, Date.now() + 1000); // export → charge
		expect(mock.states['controller.totalTarget']).to.equal(-1000);
	});
});

/*
 * Tests written against mutants that survived an external review: each one below
 * corresponds to a deliberate breakage that the suite did not notice. They assert on
 * mechanisms the rest of the suite relies on but never checks directly.
 */
describe('MultiHeadController safety mechanisms', () => {
	it('arms the watchdog when it starts', async () => {
		// Everything the watchdog protects — the stale-source failsafe, the warning, the
		// neutralisation when the source never delivers — hangs off this one call.
		// Without it all of those tests still pass, because they drive watchdogTick()
		// by hand.
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		expect(mock.intervals.length, 'the watchdog must be armed by start()').to.be.greaterThan(0);
	});

	it('warns once when the source clock keeps the loop on the override path', async () => {
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		for (let i = 0; i < 4; i++) {
			// Every sample predates the last write and the write is older than the
			// override window, so each one is a genuine override episode.
			ageWrite(ctrl, 31000);
			await ctrl.onGridPower(600 + i, Date.now() - 40000);
		}
		const clockWarnings = mock.warnings.filter(w => w.includes('clock is probably behind'));
		expect(clockWarnings.length, 'exactly one warning after three episodes').to.equal(1);
	});

	it('stays silent when fresh samples come in between', async () => {
		// A plant sitting at target delivers fresh samples with no write in between. If
		// those do not end the episode, the streak creeps up and warns about a clock
		// problem that does not exist.
		const heads = [head({ index: 1 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		for (let i = 0; i < 6; i++) {
			ageWrite(ctrl, 31000);
			await ctrl.onGridPower(600 + i, Date.now() - 40000); // one override episode
			ageWrite(ctrl, 31000);
			await ctrl.onGridPower(10 + i, Date.now()); // …ended by a fresh sample
		}
		expect(mock.warnings.filter(w => w.includes('clock is probably behind'))).to.deep.equal([]);
	});

	it('frees a saturated head once its SoC leaves the hysteresis band', async () => {
		// The memory keeps a head that hit its floor out of the split. Never clearing it
		// means a battery that has since charged is left idle until the adapter restarts.
		const heads = [head({ index: 1, soc: 5, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // empty: the head is recorded as saturated
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };
		expect([...internal.saturatedDischarge]).to.deep.equal([1]);
		heads[0].soc = 20; // charged well clear of socMin + hysteresis (10 %)
		writes.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(500, at());
		expect([...internal.saturatedDischarge], 'the memory must clear').to.deep.equal([]);
		expect(
			writes.some(w => w.gs > 0),
			'and the head must be used again',
		).to.equal(true);
	});

	it('forgets a head IS record along with the rest of it', async () => {
		// The IS dead band compares against the last value written. A head that drops out
		// and comes back has an unknown limit, so a stale record suppresses the write
		// that would restore it.
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, isAttempts } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		expect(isAttempts.length).to.be.greaterThan(0);
		ctrl.forgetHead(1);
		isAttempts.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(500, at()); // same limit as before
		expect(isAttempts.length, 'the limit must be written again').to.be.greaterThan(0);
	});

	it('lets a release through while regular IS writes are backed off', async () => {
		// The back-off exists so a dead head does not get an attempt per meter sample.
		// The release is the write that hands the limit back — if it waited for the
		// back-off the inverter would stay throttled with nobody maintaining it.
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, isAttempts, failingIs } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		failingIs.add(1);
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // fails, arming the 10 s back-off
		failingIs.delete(1);
		isAttempts.length = 0;
		heads[0].controllable = false; // loses its SoC data → the limit is released
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(500, at());
		expect(
			isAttempts.some(w => w.is === 2400),
			'the release must not wait for the failure back-off',
		).to.equal(true);
	});

	it('does not hold a second release back after the first one landed', async () => {
		// The release throttle is armed on every attempt and cleared on success. Leaving
		// it armed would block the next release for its whole interval, which is exactly
		// the window in which a head that just came back needs one.
		const heads = [head({ index: 1, lp: 400, controllable: false })];
		const { hooks, isAttempts } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // release lands
		const internal = ctrl as unknown as {
			lastIsRelease: Map<number, number>;
			lastIs: Map<number, number>;
		};
		expect([...internal.lastIsRelease.keys()], 'a landed release must not stay armed').to.deep.equal([]);
		// Drop the record the dead band would otherwise match, as a real re-release does.
		internal.lastIs.delete(1);
		isAttempts.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(500, at());
		expect(isAttempts.length, 'the next release must go out immediately').to.be.greaterThan(0);
	});

	it('reports recovering IS writes instead of carrying the old failure count', async () => {
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, failingIs } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ controlIs: true, writeDeadBandW: 1 }),
		);
		await ctrl.start();
		failingIs.add(1);
		const at = sampleClock();
		await ctrl.onGridPower(500, at());
		const internal = ctrl as unknown as {
			isWriteFailures: Map<number, { count: number; lastLog: number }>;
			lastIsFailure: Map<number, number>;
		};
		expect(internal.isWriteFailures.has(1)).to.equal(true);
		failingIs.delete(1);
		internal.lastIsFailure.delete(1); // as the back-off expiring would
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(900, at());
		expect(internal.isWriteFailures.has(1), 'a success must close the record').to.equal(false);
	});
});

describe('MultiHeadController saturation seeding', () => {
	it('does not write continuously to a head whose SoC sits inside the band', async () => {
		// The point of the whole mechanism, measured the way it hurts: an empty memory
		// after a restart releases a head the device still refuses, and the loop writes
		// roughly once every two seconds for as long as the charge stays in the band.
		const heads = [head({ index: 1, soc: 6, socMin: 5, socMax: 95, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(
			mockAdapter().adapter,
			hooks,
			'x.y.z',
			cfg({ adaptive: true, writeDeadBandW: 10 }),
		);
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		for (let i = 0; i < 60; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(600, at());
			if (i % 5 === 4) {
				ctrl.noteReportedGp(1, 0); // the device reports it is delivering nothing
			}
		}
		expect(writes.length, 'a refusing head must not be written to over and over').to.equal(0);
	});

	it('leaves a head clear of the band alone', async () => {
		const heads = [head({ index: 1, soc: 50 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(600, sampleClock()());
		expect(
			writes.some(w => w.gs > 0),
			'a healthy head must regulate immediately',
		).to.equal(true);
	});

	it('blocks only the direction the band belongs to', async () => {
		// At 6 % the device refuses to discharge, but charging is exactly what has to
		// happen for the head to leave the band at all.
		const heads = [head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		await ctrl.onGridPower(600, at()); // discharge: refused
		expect(writes).to.deep.equal([]);
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(-800, at()); // charge: must go through
		expect(
			writes.some(w => w.gs < 0),
			'charging must not be blocked',
		).to.equal(true);
	});

	it('frees the head once its charge leaves the band', async () => {
		const heads = [head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		await ctrl.onGridPower(600, at());
		heads[0].soc = 12; // above socMin + hysteresis (10 %)
		// Several cycles: the base integrates, so the total needs a moment to turn.
		for (let i = 0; i < 6; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(600, at());
		}
		expect(
			writes.some(w => w.gs > 0),
			'it must be used again',
		).to.equal(true);
	});

	it('applies the same assumption at the top of the charge range', async () => {
		const heads = [head({ index: 1, soc: 92, socMax: 95, socHysteresisCharge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		await ctrl.onGridPower(-800, at()); // charge: refused
		expect(writes).to.deep.equal([]);
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(600, at()); // discharge: must go through
		expect(
			writes.some(w => w.gs > 0),
			'discharging must not be blocked',
		).to.equal(true);
	});

	it('assumes nothing when the head has no hysteresis configured', async () => {
		const heads = [head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: 0, socHysteresisCharge: 0 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(600, sampleClock()());
		expect(
			writes.some(w => w.gs > 0),
			'without a band there is nothing to assume',
		).to.equal(true);
	});

	it('waits for real SoC data before making the assumption', async () => {
		// The placeholders a head without SoC data carries (0 / 0 / 100) would put it
		// inside a band it never reported, and the single evaluation would be spent on
		// a value we invented.
		const heads = [head({ index: 1, controllable: false, soc: 0, socMin: 0 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		const at = sampleClock();
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(600, at()); // no usable data yet
		heads[0].controllable = true;
		heads[0].soc = 50; // the first real poll: well clear of any band
		heads[0].socMin = 5;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(600, at());
		expect(
			writes.some(w => w.gs > 0),
			'it must regulate once real data arrives',
		).to.equal(true);
	});

	it('makes the assumption again for a head that dropped out and came back', async () => {
		// forgetHead() clears the memory because the head may have rebooted to GS=0.
		// That puts it back in exactly the state the assumption exists for.
		const heads = [head({ index: 1, soc: 50 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(600, at()); // evaluated while healthy
		ctrl.forgetHead(1);
		heads[0].soc = 6; // comes back inside the band
		heads[0].socMin = 5;
		writes.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(600, at());
		// A GS=0 is expected and correct: forgetHead() also dropped the record of what
		// the device is running, so the setpoint is re-asserted. What must not happen is
		// power being asked of a head the device is still holding back.
		expect(
			writes.some(w => w.gs !== 0),
			'the returning head must be judged afresh',
		).to.equal(false);
	});
});

describe('MultiHeadController saturation seeding, edges', () => {
	it('does not block a head that is simply discharging into the band', async () => {
		// The whole justification for evaluating once per head. A head coming down from
		// above passes through the band while working perfectly; re-judging it on every
		// cycle would switch it off the moment it crosses socMin + SI1.
		const heads = [head({ index: 1, soc: 50, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(600, at()); // healthy, evaluated as free
		writes.length = 0;
		heads[0].soc = 8; // discharged into the band (5…10 %)
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(600, at());
		expect(
			writes.some(w => w.gs > 0),
			'a head already working must keep working inside the band',
		).to.equal(true);
	});

	it('uses each direction’s own band width', async () => {
		// SI1 and SA1 are independent device settings. Reading the wrong one has to be
		// asserted in the direction where the split cannot cover for it: if the assumed
		// band is too *small*, the head is not seeded, the split finds an empty memory
		// and hands it power the device refuses — the write storm this exists to stop.
		// The other direction is masked, because the split recomputes the band itself
		// and clears the wrong entry again within the same cycle.
		const heads = [
			head({
				index: 1,
				soc: 18,
				socMin: 5,
				socMax: 95,
				socHysteresisDischarge: 15, // band 5…20 -> 18 % is inside
				socHysteresisCharge: 5, // the wrong width would make it 5…10: outside
			}),
		];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		writes.length = 0;
		await ctrl.onGridPower(600, sampleClock()());
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };
		expect([...internal.saturatedDischarge], 'the discharge width decides here').to.deep.equal([1]);
		expect(
			writes.some(w => w.gs > 0),
			'and nothing may be commanded',
		).to.equal(false);
	});

	it('treats the far edge of the band as still blocked', async () => {
		// The device releases *above* socMin + SI1, so a head sitting exactly on it is
		// still held. Off by one here means the storm returns for that one value.
		const heads = [
			head({ index: 1, soc: 10, socMin: 5, socHysteresisDischarge: 5 }), // exactly on the edge
			head({ index: 2, soc: 11, socMin: 5, socHysteresisDischarge: 5 }), // just past it
		];
		const { hooks } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(600, sampleClock()());
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };
		expect([...internal.saturatedDischarge]).to.deep.equal([1]);
	});

	it('treats the far edge of the charge band as still blocked', async () => {
		const heads = [
			head({ index: 1, soc: 90, socMax: 95, socHysteresisCharge: 5 }), // exactly on the edge
			head({ index: 2, soc: 89, socMax: 95, socHysteresisCharge: 5 }), // just past it
		];
		const { hooks } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(-600, sampleClock()());
		const internal = ctrl as unknown as { saturatedCharge: Set<number> };
		expect([...internal.saturatedCharge]).to.deep.equal([1]);
	});

	it('assumes nothing when the two bands overlap', async () => {
		// Generously configured bands can cover the same charge from both sides. Seeding
		// both is a trap with no exit: neither direction may move, and each release waits
		// for the other one to move the charge first. The device is never in that state.
		const heads = [
			head({
				index: 1,
				soc: 50,
				socMin: 20,
				socMax: 80,
				socHysteresisDischarge: 35, // band (20…55]
				socHysteresisCharge: 35, // band [45…80)
			}),
		];
		const { hooks, writes } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const internal = ctrl as unknown as {
			saturatedDischarge: Set<number>;
			saturatedCharge: Set<number>;
		};
		const at = sampleClock();
		await ctrl.onGridPower(800, at());
		expect([...internal.saturatedDischarge], 'neither side may be assumed').to.deep.equal([]);
		expect([...internal.saturatedCharge]).to.deep.equal([]);
		expect(
			writes.some(w => w.gs > 0),
			'and the head has to stay usable',
		).to.equal(true);
		writes.length = 0;
		// Several cycles: the loop integrates from the discharge setpoint it just made,
		// so the total needs a moment to cross zero.
		for (let i = 0; i < 4; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(-800, at());
		}
		expect(
			writes.some(w => w.gs < 0),
			'in both directions',
		).to.equal(true);
	});

	it('releases the memory on sight, not only when a setpoint is issued', async () => {
		// The memory is cleared when the split hands the head a non-zero setpoint. With
		// no grid demand it hands out zeros, so a head that charges clear of its floor
		// while the house sits on target keeps the block — and once its charge drifts
		// back into the band it is stuck there, through the night.
		const heads = [head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(500, at()); // seeded as blocked
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };
		expect([...internal.saturatedDischarge]).to.deep.equal([1]);

		heads[0].soc = 11; // PV charged it clear of socMin + SI1 …
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(0, at()); // … while the house is on target, so GS stays 0
		expect([...internal.saturatedDischarge], 'the block must lift on the observation').to.deep.equal([]);

		heads[0].soc = 9; // local load pulls it back into the band, never to the floor
		writes.length = 0;
		for (let i = 0; i < 3; i++) {
			ageWrite(ctrl, 10000);
			await ctrl.onGridPower(500, at());
		}
		expect(
			writes.some(w => w.gs > 0),
			'and the head must be usable again',
		).to.equal(true);
	});

	it('records a limit reached while the grid is balanced', async () => {
		// The block is set from the split's socLimited flag, which is false whenever the
		// total target is zero. A head that runs down to its floor while the house sits
		// on target is therefore never recorded as blocked — and the next time power is
		// wanted, the loop commands it although the device is still holding it back.
		const heads = [head({ index: 1, soc: 50, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(0, at()); // healthy, evaluated as free
		const internal = ctrl as unknown as { saturatedDischarge: Set<number> };

		heads[0].soc = 5; // local load ran it down to the floor, grid still balanced
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(0, at());
		expect([...internal.saturatedDischarge], 'the floor must be recorded').to.deep.equal([1]);

		heads[0].soc = 6; // PV lifted it a little; the device frees at 10 %
		writes.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(500, at());
		expect(
			writes.some(w => w.gs > 0),
			'nothing may be commanded inside the band',
		).to.equal(false);
	});

	it('records the ceiling the same way', async () => {
		const heads = [head({ index: 1, soc: 50, socMax: 95, socHysteresisCharge: 5 })];
		const { hooks, writes } = mockHooks(heads);
		const ctrl = new MultiHeadController(mockAdapter().adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		const at = sampleClock();
		await ctrl.onGridPower(0, at());
		const internal = ctrl as unknown as { saturatedCharge: Set<number> };

		heads[0].soc = 95; // PV filled it while the grid stayed balanced
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(0, at());
		expect([...internal.saturatedCharge], 'the ceiling must be recorded').to.deep.equal([1]);

		heads[0].soc = 94;
		writes.length = 0;
		ageWrite(ctrl, 10000);
		await ctrl.onGridPower(-500, at());
		expect(
			writes.some(w => w.gs < 0),
			'nothing may be commanded inside the band',
		).to.equal(false);
	});

	it('says in the log when it holds a head back', async () => {
		// The assumption costs real capacity for a while, and it is the answer to "why
		// is my storage idle since the restart?" — debug would hide it from exactly the
		// person asking.
		const heads = [head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: 5 })];
		const { hooks } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg());
		await ctrl.start();
		await ctrl.onGridPower(600, sampleClock()());
		expect(
			mock.infos.some(m => m.includes('hysteresis band')),
			'the assumption must be visible without debug logging',
		).to.equal(true);
	});
});

describe('MultiHeadController write failure reporting', () => {
	it('names the field that actually failed', async () => {
		// Both maps run through one helper. Reporting an IS failure as "GS write failed"
		// sends the operator looking at the wrong field.
		const heads = [head({ index: 1, lp: 400 })];
		const { hooks, failingIs } = mockHooks(heads);
		const mock = mockAdapter();
		const ctrl = new MultiHeadController(mock.adapter, hooks, 'x.y.z', cfg({ controlIs: true, writeDeadBandW: 1 }));
		await ctrl.start();
		failingIs.add(1);
		await ctrl.onGridPower(500, sampleClock()());
		expect(
			mock.warnings.some(w => w.includes('IS write failed')),
			'an IS failure must be reported as one',
		).to.equal(true);
		expect(mock.warnings.some(w => w.includes('GS write failed'))).to.equal(false);
	});
});
