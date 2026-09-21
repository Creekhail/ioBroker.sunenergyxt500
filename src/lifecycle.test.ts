/**
 * Lifecycle tests for the adapter class itself.
 *
 * Everything else in this suite tests modules that take their dependencies as
 * arguments. The adapter class cannot: it *extends* `utils.Adapter`, so merely
 * importing it pulls in `@iobroker/adapter-core`, which expects a running js-controller
 * ("Cannot find js-controller"). That is why the startup, mode-change and unload paths
 * had no tests at all — and they are where a mistake reaches the hardware.
 *
 * The harness below closes that gap with two substitutions:
 *   - `@iobroker/adapter-core` is replaced in the module cache before the adapter is
 *     loaded, so the class inherits from a mock that records every state and object
 *     write (via `@iobroker/testing`'s mock adapter and its in-memory database);
 *   - the heads are real: a local HTTP server answers /read and /write, so the actual
 *     SunEnergyXtApi is exercised rather than a stand-in, and a head can be made slow
 *     or unreachable on demand.
 *
 * It loads `src/main.ts` through ts-node, so the tests always run against the current
 * source rather than whatever happens to sit in `build/`.
 */

import { expect } from 'chai';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */

const ROOT = path.join(__dirname, '..');

/** One fake head: answers /read with a snapshot and records every /write. */
interface FakeHead {
	port: number;
	/** Fields returned by /read; tests mutate this between polls. */
	reported: Record<string, unknown>;
	/** Every payload written to this head, in order. */
	writes: Record<string, unknown>[];
	/**
	 * Requests that arrived, counted before the `dead` check.
	 *
	 * `writes` only records what a live head parsed, so a test about how often an
	 * unreachable* host is retried cannot use it — the count stays at zero however
	 * often the retry fires.
	 */
	requests: number;
	/**
	 * Highest number of requests open at the same moment.
	 *
	 * Wall-clock timing would say the same thing about jobs running together, but it
	 * says it flakily; a dead head holds every connection open, so the peak counts them.
	 */
	peakConcurrent: number;
	/** While true the head answers nothing, so requests run into their deadline. */
	dead: boolean;
	/** Delay before answering, for testing budgets rather than timeouts. */
	delayMs: number;
	/** Called with every payload as it arrives, to observe ordering against adapter state. */
	onWrite?: (payload: Record<string, unknown>) => void;
	close(): Promise<void>;
}

async function startHead(reported: Record<string, unknown> = {}): Promise<FakeHead> {
	const head: FakeHead = {
		port: 0,
		reported: {
			SC: 50,
			SA: 95,
			SI: 5,
			SI1: 5,
			SA1: 5,
			GP: 0,
			LP: 0,
			PV: 0,
			MG: 2400,
			MM: 0,
			GS: 0,
			IS: 2400,
			DevType: 'SunEnergyXT 500 PRO',
			...reported,
		},
		writes: [],
		requests: 0,
		peakConcurrent: 0,
		dead: false,
		delayMs: 0,
		close: () => Promise.resolve(),
	};
	let openNow = 0;
	const server = http.createServer((req, res) => {
		head.requests++;
		openNow++;
		head.peakConcurrent = Math.max(head.peakConcurrent, openNow);
		res.on('close', () => openNow--);
		if (head.dead) {
			return; // leave the request hanging
		}
		// A head that answers, only too late. Distinct from `dead`: the request does
		// complete, so anything that treats "did not throw" as confirmation passes while
		// the caller has long given up on it.
		const answer = (fn: () => void): void => {
			if (head.delayMs) {
				setTimeout(fn, head.delayMs);
			} else {
				fn();
			}
		};
		if (req.url === '/read') {
			answer(() => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ state: { reported: head.reported } }));
			});
			return;
		}
		let body = '';
		req.on('data', c => (body += c));
		req.on('end', () => {
			try {
				const parsed = JSON.parse(body) as { state?: Record<string, unknown> };
				if (parsed.state) {
					head.writes.push(parsed.state);
					head.onWrite?.(parsed.state);
					// Echo the write back on the next /read, like the real device.
					Object.assign(head.reported, parsed.state);
				}
			} catch {
				/* ignore malformed bodies */
			}
			answer(() => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"ok":true}');
			});
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	head.port = (server.address() as AddressInfo).port;
	head.close = () =>
		new Promise<void>(resolve => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		});
	return head;
}

/** The adapter under test plus the handles needed to drive and observe it. */
interface Harness {
	instance: any;
	states: Record<string, { val: unknown; ack: boolean }>;
	objects: Record<string, any>;
	logs: { level: string; message: string }[];
	/** Runs onReady and waits for it to settle. */
	ready(): Promise<void>;
	/** Runs onUnload and resolves once its callback fires. */
	unload(): Promise<void>;
	/** Triggers one poll cycle for the given head index. */
	poll(index: number): Promise<void>;
	/** Delivers a grid-power reading to the controller, as the state subscription would. */
	feedGrid(watts: number): Promise<void>;
	/** Issues a user command on one of our own control states (ack=false). */
	write(relId: string, value: unknown): Promise<void>;
	/** Makes the next write to this state id reject once, as a busy database would. */
	failNextStateWrite(relId: string): void;
	/** Parks every write to this state id until releaseStateWrites() is called. */
	blockStateWrite(relId: string): void;
	/** Lets every parked state write through. */
	releaseStateWrites(): void;
}

/**
 * Builds an adapter instance on top of the mock adapter core.
 *
 * @param config the instance configuration under test
 * @param presetStates states that already exist before onReady (e.g. info.gsOwned)
 */
function createHarness(config: Record<string, unknown>, presetStates: Record<string, unknown> = {}): Harness {
	const states: Record<string, { val: unknown; ack: boolean }> = {};
	const objects: Record<string, any> = {};
	const logs: { level: string; message: string }[] = [];
	for (const [id, val] of Object.entries(presetStates)) {
		states[id] = { val, ack: true };
	}
	const handlers: Record<string, (...args: any[]) => any> = {};
	const timers = new Set<NodeJS.Timeout>();
	const failOnce = new Set<string>();
	const blocked = new Set<string>();
	let waiters: (() => void)[] = [];

	const norm = (id: string): string => (id.startsWith('sunenergyxt500.0.') ? id.slice(17) : id);
	const log = (level: string) => (message: string) => logs.push({ level, message });

	class MockCore {
		public readonly namespace = 'sunenergyxt500.0';
		public readonly name = 'sunenergyxt500';
		public readonly config = config;
		public readonly log = {
			info: log('info'),
			warn: log('warn'),
			error: log('error'),
			debug: log('debug'),
		};
		public on(event: string, cb: (...args: any[]) => any): void {
			handlers[event] = cb;
		}
		public setTimeout(cb: () => void, ms: number): NodeJS.Timeout {
			const t = setTimeout(() => {
				timers.delete(t);
				cb();
			}, ms);
			timers.add(t);
			return t;
		}
		public clearTimeout(t?: NodeJS.Timeout): void {
			if (t) {
				clearTimeout(t);
				timers.delete(t);
			}
		}
		public setInterval(): undefined {
			return undefined; // watchdog is driven explicitly in these tests
		}
		public clearInterval(): void {
			/* no-op */
		}
		public async setStateAsync(id: string, v: any): Promise<void> {
			if (failOnce.delete(norm(id))) {
				throw new Error('states DB busy');
			}
			if (blocked.has(norm(id))) {
				await new Promise<void>(resolve => waiters.push(resolve));
			}
			states[norm(id)] = typeof v === 'object' && v !== null ? v : { val: v, ack: true };
		}
		public setState = this.setStateAsync;
		public setStateChangedAsync = this.setStateAsync;
		public getStateAsync(id: string): Promise<{ val: unknown; ack: boolean } | null> {
			return Promise.resolve(states[norm(id)] ?? null);
		}
		public getForeignStateAsync(): Promise<null> {
			return Promise.resolve(null);
		}
		public setObjectAsync(id: string, obj: any): Promise<void> {
			objects[norm(id)] = obj;
			return Promise.resolve();
		}
		public setObject = this.setObjectAsync;
		public setObjectNotExistsAsync(id: string, obj: any): Promise<void> {
			objects[norm(id)] ??= obj;
			return Promise.resolve();
		}
		public extendObjectAsync(id: string, part: any): Promise<void> {
			const cur = objects[norm(id)] ?? { native: {} };
			objects[norm(id)] = { ...cur, ...part, native: { ...(cur.native ?? {}), ...(part.native ?? {}) } };
			return Promise.resolve();
		}
		public extendObject = this.extendObjectAsync;
		public getAdapterObjectsAsync(): Promise<Record<string, any>> {
			return Promise.resolve(
				Object.fromEntries(Object.entries(objects).map(([k, v]) => [`sunenergyxt500.0.${k}`, v])),
			);
		}
		public delObjectAsync(id: string): Promise<void> {
			delete objects[norm(id)];
			return Promise.resolve();
		}
		public subscribeStates(): void {
			/* no-op */
		}
		public subscribeForeignStatesAsync(): Promise<void> {
			return Promise.resolve();
		}
		public sendTo(): void {
			/* no-op */
		}
	}

	const corePath = require.resolve('@iobroker/adapter-core');
	require.cache[corePath] = {
		id: corePath,
		filename: corePath,
		loaded: true,
		exports: { Adapter: MockCore, adapterDir: ROOT },
	} as any;
	const mainPath = require.resolve('./main');
	delete require.cache[mainPath];
	const factory = require(mainPath);
	const instance = typeof factory === 'function' ? factory({}) : factory;

	return {
		instance,
		states,
		objects,
		logs,
		ready: async () => {
			await handlers.ready?.();
			// Cancel the staggered background poll onReady() scheduled. Tests drive polls
			// explicitly; leaving a scheduled one running means a job can be done by the
			// background poll instead of the call under test — intermittently, so the
			// suite goes green or red depending on timing rather than on the code.
			for (const t of instance.pollTimers.values()) {
				clearTimeout(t as NodeJS.Timeout);
				timers.delete(t as NodeJS.Timeout);
			}
			instance.pollTimers.clear();
		},
		unload: () =>
			new Promise<void>(resolve => {
				const cb = (): void => {
					for (const t of timers) {
						clearTimeout(t);
					}
					timers.clear();
					resolve();
				};
				if (handlers.unload) {
					handlers.unload(cb);
				} else {
					cb();
				}
			}),
		poll: async (index: number) => {
			const heads = instance.heads;
			const h = heads.find((x: any) => x.index === index);
			// pollHead, not readAndApplyHead: the failure counter that decides when a head
			// leaves the control loop lives in the former. Calling the latter directly
			// made every test about that rule pass without the rule existing.
			await instance.pollHead(h);
		},
		failNextStateWrite: (relId: string) => failOnce.add(relId),
		blockStateWrite: (relId: string) => blocked.add(relId),
		releaseStateWrites: () => {
			blocked.clear();
			const pending = waiters;
			waiters = [];
			for (const r of pending) {
				r();
			}
		},
		write: async (relId: string, value: unknown) => {
			// Through onStateChange, so the ack check and the id parsing are exercised
			// rather than bypassed.
			handlers.stateChange?.(`sunenergyxt500.0.${relId}`, { val: value, ack: false, ts: Date.now() });
			await new Promise(r => setTimeout(r, 60));
		},
		feedGrid: async (watts: number) => {
			// Goes through the real onStateChange path, including its ack and value
			// checks, rather than calling the controller directly.
			handlers.stateChange?.('shelly.0.total', { val: watts, ack: true, ts: Date.now() });
			// onStateChange dispatches without awaiting; give the cycle time to run.
			await new Promise(r => setTimeout(r, 60));
		},
	};
}

describe('adapter lifecycle', function () {
	this.timeout(15000);
	let head1: FakeHead;

	beforeEach(async () => {
		head1 = await startHead();
	});

	afterEach(async () => {
		await head1.close();
	});

	it('clears a setpoint left behind by an earlier run', async () => {
		// info.gsOwned survived a crash: a setpoint of ours is standing on the head and
		// nothing is watching it. Starting in off mode has to clear it.
		//
		// Asserted before unload() on purpose: this is about the *startup* cleanup, and
		// including the shutdown would let a broken startup pass because the shutdown
		// happens to write the same value.
		const h = createHarness(
			{ head1Host: `127.0.0.1:${head1.port}`, controlMode: 'off', pollInterval: 3600, requestTimeout: 2000 },
			{ 'info.gsOwned': true },
		);
		head1.reported.GS = -1950; // charging at full power
		await h.ready();
		expect(
			head1.writes.some(w => w.GS === 0),
			'startup must neutralise',
		).to.equal(true);
		expect(h.states['info.gsOwned']?.val).to.equal(false);
		await h.unload();
	});

	it('neutralises the heads on shutdown, separately from the startup cleanup', async () => {
		// The shutdown path is what protects a running installation from a restart or a
		// mode change. Writes made during startup are cleared first so that only what
		// unload() itself does can satisfy this test.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		await h.poll(1); // the head becomes regulatable only once its SoC is known
		await h.feedGrid(1200); // the controller commands a real setpoint
		expect(head1.writes.some(w => typeof w.GS === 'number' && w.GS !== 0)).to.equal(true);
		head1.writes.length = 0;
		await h.unload();
		expect(
			head1.writes.some(w => w.GS === 0),
			'shutdown must write GS=0',
		).to.equal(true);
		// "controlIs off" means the adapter does not touch IS — including on the way out.
		// Without a claim on record there is nothing to hand back, and writing the maximum
		// anyway would overwrite a limit the user set, at every single stop.
		expect(
			head1.writes.every(w => !('IS' in w)),
			'and must not touch IS without a claim',
		).to.equal(true);
		expect(h.states['info.gsOwned']?.val).to.equal(false);
	});

	it('keeps ownership when the shutdown cannot reach a head', async () => {
		// If the neutralisation does not land, the flag must stay set — that is the only
		// thing that makes the next start finish the job.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 300,
		});
		await h.ready();
		await h.poll(1); // the head becomes regulatable only once its SoC is known
		await h.feedGrid(1200);
		head1.dead = true; // head stops answering before the shutdown
		await h.unload();
		expect(h.states['info.gsOwned']?.val, 'ownership must survive a failed shutdown').to.equal(true);
	});

	it('releases the inverter limit on shutdown when it steered IS', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			controllerControlIs: true,
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		await h.poll(1); // the head becomes regulatable only once its SoC is known
		await h.feedGrid(1200);
		head1.writes.length = 0;
		await h.unload();
		const released = head1.writes.find(w => 'IS' in w);
		expect(released, 'shutdown must hand IS back').to.not.equal(undefined);
		expect(released?.IS).to.equal(2400);
	});

	it('does not let a pending cleanup write after the shutdown', async () => {
		// A poll that is still in flight resumes after the unload callback has run. Its
		// cleanup retry would then write to a device the adapter has just finished
		// letting go of — api.destroy() tears down sockets but does not stop new requests.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{ 'info.gsOwned': true },
		);
		head1.dead = true; // unreachable at startup, so a cleanup stays outstanding
		await h.ready();
		head1.dead = false;
		await h.unload();
		head1.writes.length = 0;
		await h.poll(1); // the in-flight poll resumes after shutdown
		expect(head1.writes, 'nothing may be written after the shutdown').to.deep.equal([]);
	});

	it('does not touch the heads when it never owned a setpoint', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		await h.unload();
		expect(head1.writes).to.deep.equal([]);
	});

	it('keeps ownership when a head cannot be reached, and finishes on a later poll', async () => {
		const h = createHarness(
			{ head1Host: `127.0.0.1:${head1.port}`, controlMode: 'off', pollInterval: 3600, requestTimeout: 300 },
			{ 'info.gsOwned': true },
		);
		head1.dead = true; // unreachable during startup
		await h.ready();
		expect(h.states['info.gsOwned']?.val).to.equal(true); // still owed
		head1.dead = false;
		await h.poll(1); // head answers again
		expect(head1.writes.some(w => w.GS === 0)).to.equal(true);
		expect(h.states['info.gsOwned']?.val).to.equal(false);
		await h.unload();
	});

	it('refuses controller mode without a source and leaves the devices alone', async () => {
		// The dangerous half of this is enforceMode: switching the device's own
		// regulation off and then not taking over would leave nothing regulating.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: '',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		expect(head1.writes.some(w => 'MM' in w)).to.equal(false);
		expect(h.logs.some(l => l.level === 'error' && l.message.includes('no grid-power source'))).to.equal(true);
		await h.unload();
	});

	it('refuses a grid source that points at its own states', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'sunenergyxt500.0.total.gridPower',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		expect(head1.writes.some(w => 'MM' in w)).to.equal(false);
		expect(h.logs.some(l => l.level === 'error' && l.message.includes('own states'))).to.equal(true);
		await h.unload();
	});

	it('claims ownership as soon as the controller starts', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		// Must be recorded before the first setpoint goes out, so a crash in between is
		// still recoverable on the next start.
		expect(h.states['info.gsOwned']?.val).to.equal(true);
		await h.unload();
	});

	it('keeps user-created objects and removes only its own orphans', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		// One object a user added under our tree, one leftover of ours, one foreign.
		h.objects['heads.1.userNote'] = { type: 'state', common: {}, native: {} };
		h.objects['heads.1.control.OBSOLETE'] = {
			type: 'state',
			common: {},
			native: { createdBy: 'sunenergyxt500' },
		};
		h.objects['battery.SC'] = { type: 'state', common: {}, native: {} }; // 0.1.x legacy
		await h.ready();
		expect(h.objects['heads.1.userNote'], 'user object must survive').to.not.equal(undefined);
		expect(h.objects['heads.1.control.OBSOLETE'], 'our orphan must go').to.equal(undefined);
		expect(h.objects['battery.SC'], 'legacy tree must go').to.equal(undefined);
		await h.unload();
	});
});

/*
 * Tests written against mutants that survived an external review. Each one breaks a
 * mechanism the rest of the suite depends on but never asserts directly — the class
 * of gap where a test looks like it covers something and does not.
 */
describe('adapter lifecycle: guarded mechanisms', function () {
	this.timeout(20000);
	let head1: FakeHead;

	beforeEach(async () => {
		head1 = await startHead();
	});

	afterEach(async () => {
		await head1.close();
	});

	it('records ownership before the first setpoint leaves, not after', async () => {
		// Asserting the flag after ready() passes whichever order the code uses. What
		// matters is that a crash *between* the write and the flag is still recoverable,
		// so the state has to be true at the moment the device sees the first write.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		let ownedAtFirstWrite: unknown = 'no setpoint seen';
		head1.onWrite = payload => {
			// The first write of all is the mode enforcement (MM/MD); what has to be
			// preceded by the record is the first *setpoint*.
			if ('GS' in payload && ownedAtFirstWrite === 'no setpoint seen') {
				ownedAtFirstWrite = h.states['info.gsOwned']?.val;
			}
		};
		await h.ready();
		expect(ownedAtFirstWrite, 'ownership must already be recorded').to.equal(true);
		await h.unload();
	});

	it('keeps a head in the control loop until several polls in a row have failed', async () => {
		// A head is marked offline after one missed poll while it keeps executing its
		// setpoint. Dropping it from the loop that early hands it to nobody.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 300,
		});
		await h.ready();
		await h.poll(1);
		head1.dead = true;
		await h.poll(1);
		expect(h.instance.headStates()[0].online, 'one missed poll must not drop it').to.equal(true);
		await h.poll(1);
		await h.poll(1);
		expect(h.instance.headStates()[0].online, 'three in a row must').to.equal(false);
		head1.dead = false;
		await h.unload();
	});

	it('neutralises a head the poll loop has given up on', async () => {
		// Writing only to heads the poll calls online skips exactly the ones that need
		// it most: a head in its back-off window still executes its last setpoint.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 300,
		});
		await h.ready();
		await h.poll(1);
		await h.feedGrid(1200); // a real setpoint is standing
		head1.dead = true;
		for (let i = 0; i < 4; i++) {
			await h.poll(1); // polls fail: the head is now tracked as offline
		}
		expect(h.instance.heads[0].online).to.equal(false);
		head1.dead = false; // reachable again for writes, still tracked offline
		head1.writes.length = 0;
		await h.unload();
		expect(
			head1.writes.some(w => w.GS === 0),
			'an offline-tracked head must still be neutralised',
		).to.equal(true);
	});

	it('keeps ownership when the shutdown runs out of budget', async () => {
		// The head answers, only too late. Treating "the request finished eventually" as
		// confirmation drops the ownership record while a setpoint is still standing.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 10000,
		});
		await h.ready();
		await h.poll(1);
		await h.feedGrid(1200);
		head1.delayMs = 4000; // well past the 2 s neutralisation budget
		await h.unload();
		expect(h.states['info.gsOwned']?.val, 'the record must survive an unconfirmed shutdown').to.equal(true);
		head1.delayMs = 0;
	});

	it('refuses to switch local mode off while a control mode is active', async () => {
		// LM=0 is how the adapter loses access to the device. Doing that with a setpoint
		// standing strands it with no way left to clear it.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		head1.writes.length = 0;
		await h.write('heads.1.control.LM', false);
		expect(
			head1.writes.some(w => 'LM' in w),
			'LM must not be written',
		).to.equal(false);
		expect(h.logs.some(l => l.level === 'warn' && l.message.includes('local mode'))).to.equal(true);
		await h.unload();
	});

	it('rejects an out-of-range control value instead of passing it to the hardware', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		head1.writes.length = 0;
		await h.write('heads.1.control.SI', 150); // a percentage, so 0…100
		expect(head1.writes, 'nothing may reach the device').to.deep.equal([]);
		expect(h.logs.some(l => l.level === 'warn' && l.message.includes('out-of-range'))).to.equal(true);
		await h.unload();
	});

	it('hands inherited responsibility to the controller', async () => {
		// The controller only knows what it wrote itself. A head whose initial
		// neutralisation failed and that then loses its SoC data looks untouched to it,
		// so an inherited setpoint on it would never be cleared.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{ 'info.gsOwned': true },
		);
		head1.dead = true; // the start neutralisation cannot land
		await h.ready();
		head1.dead = false;
		delete head1.reported.SC; // answers, but without usable SoC data
		delete head1.reported.SI;
		delete head1.reported.SO;
		await h.poll(1);
		head1.writes.length = 0;
		await h.feedGrid(1200);
		expect(
			head1.writes.some(w => w.GS === 0),
			'the inherited setpoint must be cleared',
		).to.equal(true);
		await h.unload();
	});

	it('survives a control cycle that throws', async () => {
		// The dispatch is deliberately not awaited, so an unhandled rejection would take
		// the process down under Node's default — leaving every head executing its last
		// setpoint with nothing watching it.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		let unhandled: unknown;
		const onUnhandled = (e: unknown): void => {
			unhandled = e;
		};
		process.on('unhandledRejection', onUnhandled);
		try {
			h.instance.controller.onGridPower = () => Promise.reject(new Error('cycle exploded'));
			await h.feedGrid(1200);
			await new Promise(r => setTimeout(r, 50)); // let the rejection surface
			expect(unhandled, 'the rejection must be handled').to.equal(undefined);
			expect(h.logs.some(l => l.level === 'error' && l.message.includes('cycle exploded'))).to.equal(true);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
		await h.unload();
	});

	it('does not release a maximum it has read but not yet taken over', async () => {
		// The first poll marks itself done before it copies the snapshot into the head's
		// runtime fields, with two awaits in between. A shutdown landing in that window
		// sees "the model is known" and hands back the constructor default — 2400 W to a
		// head that has just reported 800.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				controllerControlIs: true,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{},
		);
		head1.reported.MG = 800; // a 500, not a PRO
		await h.ready();
		h.blockStateWrite('heads.1.info.rawResponse'); // park the poll mid-way
		const poll = h.poll(1);
		await new Promise(r => setTimeout(r, 60));
		head1.writes.length = 0;
		await h.unload();
		h.releaseStateWrites();
		await poll;
		const released = head1.writes.find(w => 'IS' in w);
		expect(released?.IS, 'never a maximum the head did not report').to.not.equal(2400);
		expect(
			head1.writes.some(w => w.GS === 0),
			'the setpoint must still be neutralised',
		).to.equal(true);
	});

	it('does not invent an inverter maximum on shutdown', async () => {
		// Before the first successful poll `maxPower` is the constructor default of
		// 2400 W. Handing that to a 500 (800 W) on the way out is the same invented
		// maximum the startup cleanup already refuses to write.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				controllerControlIs: true,
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{},
		);
		head1.reported.MG = 800; // a 500, not a PRO
		head1.dead = true; // never polled, so the model stays unknown
		await h.ready();
		head1.dead = false;
		head1.writes.length = 0;
		await h.unload();
		expect(
			head1.writes.some(w => 'IS' in w),
			'no limit may be written while the model is a guess',
		).to.equal(false);
		expect(
			head1.writes.some(w => w.GS === 0),
			'the setpoint must still be neutralised',
		).to.equal(true);
	});

	it('stops the inverter-limit release once the shutdown has begun', async () => {
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				controllerControlIs: false,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{},
		);
		head1.reported.IS = 0;
		await h.ready(); // no poll yet, so the release stays pending
		await h.unload();
		head1.writes.length = 0;
		await h.poll(1);
		expect(
			head1.writes.some(w => 'IS' in w),
			'no limit write may follow the shutdown',
		).to.equal(false);
	});
});

/*
 * The binding and inverter-limit paths were tested on one startup branch each and not
 * at all in the retry. These cover the other branches, which is where the last round's
 * findings actually sat.
 */
describe('adapter lifecycle: binding and limit ownership', function () {
	this.timeout(30000);
	let head1: FakeHead;

	beforeEach(async () => {
		head1 = await startHead();
	});

	afterEach(async () => {
		await head1.close();
	});

	it('does not enforce the mode on a head after the shutdown', async () => {
		// A poll already in flight resumes after unload; its mode guard writes MM/MD to a
		// device the adapter has just let go of.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'controller',
			gridPowerStateId: 'shelly.0.total',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		await h.unload();
		head1.writes.length = 0;
		head1.reported.MM = 1; // as if something had switched it back on
		await h.poll(1);
		expect(head1.writes, 'no mode write may follow the shutdown').to.deep.equal([]);
	});
});
