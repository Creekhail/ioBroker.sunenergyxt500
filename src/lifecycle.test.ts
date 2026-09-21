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
import type { HeadState } from './lib/split';

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
			// js-controller merges deeply (`extend(true, oldObj, obj)`), so a partial
			// { common: { max } } keeps name, role and unit. A shallow merge here would
			// replace common wholesale and hide exactly the bug that would cause.
			const deep = (base: any, patch: any): any => {
				const out = { ...base };
				for (const [k, v] of Object.entries(patch)) {
					out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deep(base?.[k] ?? {}, v) : v;
				}
				return out;
			};
			objects[norm(id)] = deep(objects[norm(id)] ?? { native: {} }, part);
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

	it('keeps the meter binding when the refusal forces the mode to off', async () => {
		// The refusal above promises to leave the devices as they are. Restoring the
		// release broke that promise: it switched the device's own regulation off while
		// the adapter regulation the owner asked for could not start either.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: '',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{ 'info.meterBound': true }, // an earlier run bound it in device mode
		);
		head1.reported.MM = 1;
		await h.ready();
		expect(head1.writes, 'a forced off must not touch the binding').to.deep.equal([]);
		expect(h.states['info.meterBound']?.val, 'and must not forget it either').to.equal(true);
		await h.unload();
	});

	it('still clears an orphaned setpoint when the mode is forced to off', async () => {
		// The other half of what the refusal promises. It leaves the device's own
		// regulation alone, but a GS from a run that ended badly has nobody watching it —
		// and the refusal means nobody is about to start, either.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: '',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{ 'info.gsOwned': true }, // a controller run that never neutralised
		);
		head1.reported.GS = -1500;
		await h.ready();
		expect(
			head1.writes.some(w => w.GS === 0),
			'the setpoint has to go even though the controller cannot start',
		).to.equal(true);
		expect(
			head1.writes.some(w => 'MM' in w),
			'but the binding is not touched',
		).to.equal(false);
		await h.unload();
	});

	it('keeps the meter binding when the source points at the adapter itself', async () => {
		// The third of the three refusals. Each sets the flag on its own line, so each
		// needs its own case — this one had none.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'sunenergyxt500.0.total.gridPower',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{ 'info.meterBound': true },
		);
		head1.reported.MM = 1;
		await h.ready();
		expect(head1.writes, 'a forced off must not touch the binding').to.deep.equal([]);
		expect(h.states['info.meterBound']?.val).to.equal(true);
		await h.unload();
	});

	it('keeps the meter binding when device mode is refused for having several heads', async () => {
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				// A second, distinct host: the same one twice is deduplicated, which would
				// leave a single head and no refusal at all.
				head2Host: '127.0.0.1:1',
				controlMode: 'device',
				meterType: 'ecotracker',
				meterId: '192.168.1.50',
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{ 'info.meterBound': true },
		);
		await h.ready();
		expect(head1.writes.some(w => 'MM' in w)).to.equal(false);
		expect(h.states['info.meterBound']?.val).to.equal(true);
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
/**
 * The response from section 3.1 of the manufacturer's API document, field for field.
 *
 * One exception: II/VP are sent as tenths by the device, and both this adapter and the
 * vendor's own integration scale them by 0.1. The document's example writes them already
 * scaled (`II1: 2.1`, `VP1: 219.0`) — which is why the values below are the tenths that
 * produce them, and why the expectations further down are the document's own numbers.
 */
const API_SAMPLE: Record<string, unknown> = {
	SN: 'TBe072a1edb090',
	PK: 2,
	ST: 1,
	PV: 1820,
	PV1: 460,
	PV2: 455,
	PV3: 450,
	PV4: 455,
	II1: 21,
	II2: 21,
	II3: 20,
	II4: 21,
	VP1: 2190,
	VP2: 2186,
	VP3: 2188,
	VP4: 2189,
	IW: 1820,
	OP: 1510,
	GP: -1530,
	LP: 0,
	BP: 1450,
	SC: 54,
	SC0: 54,
	PD: 6230,
	GD1: 5683,
	GD2: 4789,
	LD: 0,
	GS: -1550,
	IS: 2400,
	LM: 0,
	MM: 1,
	MS: 1,
	IP: '192.168.1.102',
	COM: 80,
	ES: '1.1.3',
	AS: '1.0.6',
	DS: '1.0.5',
	BS0: '4.0.5',
	timestamp: 1712476800000,
};

describe('adapter lifecycle: field mapping', function () {
	this.timeout(30000);
	let head1: FakeHead;

	beforeEach(async () => {
		head1 = await startHead();
		head1.reported = { ...API_SAMPLE };
	});

	afterEach(async () => {
		await head1.close();
	});

	/**
	 * Builds a harness in monitoring mode — no control path, so nothing writes back.
	 */
	function monitorOnly(): Harness {
		return createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
	}

	it('publishes every field of the documented response where it belongs', async () => {
		// The gap every review named: each field is mapped in exactly one place, so a
		// transposed pair (GP into BP, a sign, a scale) passes every other test in here.
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		const v = (id: string): unknown => h.states[`heads.1.${id}`]?.val;
		expect({
			sn: v('device.SN'),
			pk: v('device.PK'),
			st: v('device.ST'),
			pv: v('pv.PV'),
			mppt: [v('pv.mppt1.PV1'), v('pv.mppt2.PV2'), v('pv.mppt3.PV3'), v('pv.mppt4.PV4')],
			current: [v('pv.mppt1.II1'), v('pv.mppt2.II2'), v('pv.mppt3.II3'), v('pv.mppt4.II4')],
			voltage: [v('pv.mppt1.VP1'), v('pv.mppt2.VP2'), v('pv.mppt3.VP3'), v('pv.mppt4.VP4')],
			iw: v('system.IW'),
			op: v('system.OP'),
			gp: v('grid.GP'),
			lp: v('load.LP'),
			bp: v('battery.BP'),
			sc: v('battery.SC'),
			sc0: v('battery.SC0'),
			pd: v('pv.PD'),
			gd1: v('grid.GD1'),
			gd2: v('grid.GD2'),
			ld: v('load.LD'),
			gs: v('control.GS'),
			is: v('control.IS'),
			lm: v('control.LM'),
			mm: v('control.MM'),
			ms: v('meter.MS'),
			ip: v('device.network.IP'),
			com: v('device.network.COM'),
			firmware: [
				v('device.firmware.ES'),
				v('device.firmware.AS'),
				v('device.firmware.DS'),
				v('device.firmware.BS0'),
			],
			timestamp: v('info.timestamp'),
		}).to.deep.equal({
			sn: 'TBe072a1edb090',
			pk: 2,
			st: 1,
			pv: 1820,
			mppt: [460, 455, 450, 455],
			current: [2.1, 2.1, 2, 2.1],
			voltage: [219, 218.6, 218.8, 218.9],
			iw: 1820,
			op: 1510,
			gp: -1530, // negative = import, as the document defines it
			lp: 0,
			bp: 1450, // positive = charging, the opposite sign convention to GP
			sc: 54,
			sc0: 54,
			pd: 6230, // Wh, unscaled — the vendor's integration shows the same figure in kWh
			gd1: 5683,
			gd2: 4789,
			ld: 0,
			gs: -1550,
			is: 2400,
			lm: false, // LM/MM are 0/1 on the wire and boolean here
			mm: true,
			ms: 1,
			ip: '192.168.1.102',
			com: 80,
			firmware: ['1.1.3', '1.0.6', '1.0.5', '4.0.5'],
			timestamp: 1712476800000,
		});
	});

	it('hands the controller the same reading, in its own terms', async () => {
		// The second half of the same gap: the states can be right while the snapshot the
		// split works from reads a field from the wrong place.
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		const heads = (h.instance as { headStates(): HeadState[] }).headStates();
		expect(heads.length).to.equal(1);
		const [head] = heads;
		expect({ gp: head.gp, soc: head.soc, lp: head.lp, pv: head.pv }).to.deep.equal({
			gp: -1530,
			soc: 54,
			lp: 0,
			pv: 1820,
		});
		// MG is absent from the documented response; the model decides, and PK=2 is a PRO.
		expect(head.maxPower).to.equal(2400);
	});

	it('hands over three separate limits, not the export cap three times', async () => {
		// headStates() is the only place the limit separation enters the adapter, and the
		// controller and split tests supply their own mock values — so the whole of
		// d1ea6c7 could be undone here with all tests still green.
		head1.reported = { ...API_SAMPLE, MG: 800 };
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		const [head] = (h.instance as { headStates(): HeadState[] }).headStates();
		expect({
			maxPower: head.maxPower,
			maxCharge: head.maxCharge,
			maxInverter: head.maxInverter,
		}).to.deep.equal({ maxPower: 800, maxCharge: 2400, maxInverter: 2400 });
	});

	it('recognises the standard model from DevType when PK is absent', async () => {
		// Older firmware does not report PK. The targeted model tests all set PK=1, so the
		// DevType path carried the whole 800 W rating untested.
		head1.reported = { ...API_SAMPLE, PK: undefined, DevType: 'SunEnergyXT 500', GS: 0 };
		delete head1.reported.PK;
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		expect(h.objects['heads.1.control.GS']?.common?.max).to.equal(800);
		const [head] = (h.instance as { headStates(): HeadState[] }).headStates();
		expect(head.maxPower, 'the controller gets the same rating as the object bound').to.equal(800);
	});

	it('writes the narrowed bound once, not on every poll', async () => {
		// Without the change check this is one object write per model-limited field, per
		// head, per poll — for a value that cannot change while the head is the same.
		head1.reported = { ...API_SAMPLE, PK: 1, GS: 0 };
		const h = monitorOnly();
		await h.ready();
		const writes: string[] = [];
		const inst = h.instance as { extendObject(id: string, part: unknown): Promise<void> };
		const real = inst.extendObject.bind(inst);
		inst.extendObject = (id: string, part: unknown): Promise<void> => {
			writes.push(id);
			return real(id, part);
		};
		await h.poll(1);
		const first = writes.filter(id => id.endsWith('control.GS')).length;
		await h.poll(1);
		await h.poll(1);
		expect(first, 'the first poll narrows the bound').to.equal(1);
		expect(writes.filter(id => id.endsWith('control.GS')).length, 'later polls must not rewrite it').to.equal(
			first,
		);
	});

	it('refuses a manual write above what the model is rated for', async () => {
		// Until a poll says otherwise the objects carry the PRO bound, so this can only be
		// enforced from the model — and only for the output fields. A 500 takes the same
		// 2400 W in and its inverter is rated the same, so lowering those too would block
		// writes the device would have accepted.
		head1.reported = { ...API_SAMPLE, PK: 1, GS: 0 };
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		head1.writes.length = 0;
		await h.write('heads.1.control.GS', 1500);
		expect(head1.writes, 'above the 800 W rating').to.deep.equal([]);
		await h.write('heads.1.control.IS', 1500);
		expect(head1.writes, 'the inverter limit is not model-bound').to.deep.equal([{ IS: 1500 }]);
		head1.writes.length = 0;
		await h.write('heads.1.control.MG', 1500);
		expect(head1.writes, 'the export cap is bounded by the rating as well').to.deep.equal([]);
	});

	it('takes the rating from the model, not from the export cap in force', async () => {
		// A PRO whose owner capped feed-in at 800 W is still a PRO. Deriving the bound
		// from MG would lock them out of ever raising their own setting again.
		head1.reported = { ...API_SAMPLE, PK: 2, MG: 800, GS: 0 };
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		head1.writes.length = 0;
		await h.write('heads.1.control.MG', 2400);
		expect(head1.writes, 'raising a self-imposed cap must stay possible').to.deep.equal([{ MG: 2400 }]);
	});

	it('refuses IS=0, which the device does not offer', async () => {
		// The documented range is 1..2400. Zero reads like "no limit" and is the opposite:
		// it would ask the inverter to produce nothing at all.
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		head1.writes.length = 0;
		await h.write('heads.1.control.IS', 0);
		expect(head1.writes).to.deep.equal([]);
		expect(h.logs.some(l => l.level === 'warn' && l.message.includes('out-of-range'))).to.equal(true);
	});

	it('takes the 800 W model limit from PK, not from a guess', async () => {
		head1.reported = { ...API_SAMPLE, PK: 1, GS: 0 };
		const h = monitorOnly();
		await h.ready();
		await h.poll(1);
		const [head] = (h.instance as { headStates(): HeadState[] }).headStates();
		expect(head.maxPower, 'PK=1 is the 800 W model').to.equal(800);
		expect(h.objects['heads.1.control.GS']?.common?.max, 'and the writable bound follows it').to.equal(800);
		expect(
			h.objects['heads.1.control.IS']?.common?.max,
			'while the inverter limit stays at the device maximum',
		).to.equal(2400);
		expect(
			h.objects['heads.1.control.MG']?.common?.max,
			'the export cap field is narrowed as well, not only GS',
		).to.equal(800);
		// Narrowing the bound must not strip the rest of the definition off the object.
		const gs = h.objects['heads.1.control.GS']?.common;
		expect({ min: gs?.min, unit: gs?.unit, role: gs?.role, write: gs?.write }).to.deep.equal({
			min: -2400,
			unit: 'W',
			role: 'level',
			write: true,
		});
	});
});

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

	it('releases the device inverter maximum, not the head export cap', async () => {
		// MG is the grid-tied *output* cap; IS is 1..2400 on both models. Releasing IS to
		// MG left a head whose owner capped feed-in at 800 W unable to serve its own load
		// port, with nothing left running to raise it again.
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
		// Without this poll the head's export cap is still the constructor default of
		// 2400, and the assertion below would be satisfied by that default rather than by
		// the released device maximum — both reviews caught the test that way.
		await h.poll(1);
		expect(
			(h.instance as { headStates(): HeadState[] }).headStates()[0].maxPower,
			'the export cap has to be the lowered one for this test to mean anything',
		).to.equal(800);
		head1.writes.length = 0;
		await h.unload();
		const released = head1.writes.find(w => 'IS' in w);
		expect(released?.IS, 'the inverter maximum is model-independent').to.equal(2400);
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

	it('records the meter binding it established in device mode', async () => {
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'device',
			meterType: 'ecotracker',
			meterId: '192.168.1.99',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		expect(
			head1.writes.some(w => w.MM === 1),
			'device mode binds the meter',
		).to.equal(true);
		expect(h.states['info.meterBound']?.val, 'and remembers that it did').to.equal(true);
	});

	it('releases its own meter binding when the mode is switched to off', async () => {
		// The binding outlives the adapter: MM/MD stay on the device until something
		// clears them. An owner who switches the adapter off would otherwise keep a
		// device regulating against a meter the adapter configured and no longer serves.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{ 'info.meterBound': true }, // an earlier run in device mode
		);
		await h.ready();
		expect(head1.writes).to.deep.equal([{ MM: 0, MD: '' }]);
		expect(h.states['info.meterBound']?.val, 'the record is cleared once it landed').to.equal(false);
	});

	it('keeps the record when the release did not reach the head', async () => {
		// The one place this differs from the version that shipped: a release that failed
		// leaves the flag standing, so the next start tries again. No retry loop needed —
		// the mode is enforced on every start anyway.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{ 'info.meterBound': true },
		);
		head1.dead = true;
		await h.ready();
		expect(h.states['info.meterBound']?.val, 'an unconfirmed release is not a release').to.equal(true);
	});

	it('drops the record when controller mode clears the binding', async () => {
		// Controller mode writes MM=0/MD='' to every head, so the binding is gone. Leaving
		// the flag set would have a later switch to off release a binding nobody holds.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{ 'info.meterBound': true },
		);
		await h.ready();
		expect(h.states['info.meterBound']?.val).to.equal(false);
	});

	it('leaves a binding the adapter never made alone', async () => {
		// Off mode means hands off. A binding the owner set up in the app is theirs, and
		// clearing it would stop a device that was regulating perfectly well without us.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		head1.reported.MM = 1; // bound, but not by this adapter
		await h.ready();
		expect(head1.writes, 'off mode writes nothing it did not set itself').to.deep.equal([]);
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
