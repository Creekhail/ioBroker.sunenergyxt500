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
		public setStateAsync(id: string, v: any): Promise<void> {
			if (failOnce.delete(norm(id))) {
				return Promise.reject(new Error('states DB busy'));
			}
			states[norm(id)] = typeof v === 'object' && v !== null ? v : { val: v, ack: true };
			return Promise.resolve();
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

	it('cleans up a head that is no longer configured', async () => {
		// The previous run left a setpoint on two heads; only one is configured now. The
		// other is still out there executing it, so the recorded host list — not the
		// current configuration — has to decide who gets written to.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			await h.ready();
			expect(
				head1.writes.some(w => w.GS === 0),
				'configured head',
			).to.equal(true);
			expect(
				gone.writes.some(w => w.GS === 0),
				'head no longer configured',
			).to.equal(true);
			expect(h.states['info.gsOwned']?.val).to.equal(false);
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('cleans up a head that is no longer configured, in controller mode too', async () => {
		// The case the host list was built for: a user drops a head from the config and
		// stays in controller mode — which is the normal thing to do. Starting the
		// controller must not discard the record of heads it still has to clean up.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.reported.GS = 1200; // still discharging from the previous run
			await h.ready();
			expect(
				gone.writes.some(w => w.GS === 0),
				'the removed head must be neutralised',
			).to.equal(true);
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('does not neutralise a head that was never part of the cleanup job', async () => {
		// The outstanding job is about head A, which is unreachable. Head B polls happily
		// and must be left alone — it is running its own setpoint, not ours from a
		// previous configuration.
		const b = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${b.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					// A is not configured any more and answers nothing (port 1 is closed).
					'info.gsOwnedHosts': JSON.stringify(['127.0.0.1:1']),
				},
			);
			await h.ready();
			b.writes.length = 0;
			await h.poll(1); // B polls; the retry must not pick it up
			expect(b.writes, 'B is not part of the job').to.deep.equal([]);
			expect(h.states['info.gsOwned']?.val, 'the job is still outstanding').to.equal(true);
			await h.unload();
		} finally {
			await b.close();
		}
	});

	it('keeps a removed head on the record when the controller start cannot reach it', async () => {
		// The head that gets dropped from the configuration is usually the one that was
		// misbehaving — so it is also the one most likely to be unreachable at the very
		// moment the cleanup runs. Losing it there means it carries its setpoint forever.
		const gone = await startHead();
		const gonePort = gone.port;
		gone.dead = true; // unreachable during startup
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gonePort}`]),
				},
			);
			await h.ready();
			// Still on the record even though the controller has taken over.
			expect(JSON.parse(String(h.states['info.gsOwnedHosts']?.val))).to.include(`127.0.0.1:${gonePort}`);
			// It comes back; a poll of the configured head must carry the retry.
			gone.dead = false;
			(h.instance as { lastForeignRetry: number }).lastForeignRetry = 0;
			await h.poll(1);
			expect(
				gone.writes.some(w => w.GS === 0),
				'removed head must be neutralised',
			).to.equal(true);
			await h.unload();
			expect(h.states['info.gsOwned']?.val, 'now it may be released').to.equal(false);
		} finally {
			await gone.close();
		}
	});

	it('does not drop ownership while a removed head is still owed', async () => {
		const gone = await startHead();
		gone.dead = true;
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			await h.ready();
			await h.unload(); // configured head confirms, the removed one never did
			expect(h.states['info.gsOwned']?.val, 'ownership must survive').to.equal(true);
			expect(JSON.parse(String(h.states['info.gsOwnedHosts']?.val))).to.deep.equal([`127.0.0.1:${gone.port}`]);
		} finally {
			await gone.close();
		}
	});

	it('hands the inverter limit back once the head reports its real maximum', async () => {
		// The startup cleanup skips IS while maxPower is still the constructor default —
		// writing 2400 W to a 500 would be worse than writing nothing. But an IS left by
		// an earlier run must not stay on the device for good either.
		head1.reported.MG = 800; // a 500, not a PRO
		head1.reported.IS = 300; // throttled by the previous run
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				controllerControlIs: true,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.gsOwned': true,
				'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		await h.ready();
		expect(
			head1.writes.some(w => 'IS' in w),
			'not before the model is known',
		).to.equal(false);
		await h.poll(1); // now MG=800 is known
		const released = head1.writes.find(w => 'IS' in w);
		expect(released, 'IS must be handed back afterwards').to.not.equal(undefined);
		expect(released?.IS, 'and at the real maximum, not a guess').to.equal(800);
		await h.unload();
	});

	it('does not release a meter binding on a head it never bound', async () => {
		// Head 1 now points at a different device than when the binding was made.
		// Releasing "heads[0]" would clear a binding on hardware we never touched.
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${other.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify(['127.0.0.1:1']) },
			);
			await h.ready();
			expect(
				other.writes.some(w => 'MM' in w),
				'foreign binding must be left alone',
			).to.equal(false);
			await h.unload();
		} finally {
			await other.close();
		}
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
			{ 'info.gsOwned': true, 'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]) },
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

	it('releases a binding left on a device head 1 no longer points at', async () => {
		// The binding record names a device. If head 1 is repointed at another one, the
		// old device keeps self-regulating from our meter while a second controller
		// works the same battery — and overwriting the record destroys the only trace.
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'device',
					meterType: 'ecotracker',
					meterId: '192.168.1.99',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			await h.ready();
			expect(
				other.writes.some(w => w.MM === 0),
				'the device we bound earlier must be released',
			).to.equal(true);
			await h.unload();
		} finally {
			await other.close();
		}
	});

	it('keeps the binding on record when the bound host is not configured', async () => {
		// Nothing here can reach that device, so forgetting it makes the advice in the
		// warning ("point head 1 at it once") impossible to follow.
		const h = createHarness(
			{ head1Host: `127.0.0.1:${head1.port}`, controlMode: 'off', pollInterval: 3600, requestTimeout: 2000 },
			{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify(['127.0.0.1:1']) },
		);
		await h.ready();
		expect(h.states['info.meterBound']?.val, 'the record must survive').to.equal(true);
		expect(JSON.parse(String(h.states['info.meterBoundHosts']?.val))).to.deep.equal(['127.0.0.1:1']);
		await h.unload();
	});

	it('hands back an inverter limit claimed by a run that had IS control enabled', async () => {
		// The option is off *now*; the throttled limit is a fact from *then*. Deriving
		// one from the other leaves the inverter shut while the controller integrates
		// against it.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				controllerControlIs: false,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.gsOwned': true,
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		head1.reported.IS = 0; // throttled shut by the earlier run
		await h.ready();
		await h.poll(1); // the real MG only arrives with the first poll
		expect(
			head1.writes.some(w => w.IS === 2400),
			'the limit must be handed back',
		).to.equal(true);
		expect(h.states['info.isOwned']?.val).to.equal(false);
		await h.unload();
	});

	it('remembers an outstanding IS release across a restart', async () => {
		// GS is confirmed and its ownership cleared, but the limit is still throttled
		// because the head had not been polled yet. If that fact lives only in RAM the
		// next run has no reason to finish the job.
		const hosts = JSON.stringify([`127.0.0.1:${head1.port}`]);
		const cfg = {
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'off' as const,
			controllerControlIs: false,
			pollInterval: 3600,
			requestTimeout: 2000,
		};
		const first = createHarness(cfg, {
			'info.gsOwned': true,
			'info.isOwned': true,
			'info.isOwnedHosts': hosts,
		});
		head1.reported.IS = 0;
		await first.ready(); // GS=0 lands, no poll happened, so IS stays pending
		await first.unload();
		expect(first.states['info.isOwned']?.val, 'the claim must outlive the run').to.equal(true);

		// Carries the first run's states over rather than restating them: the point is
		// that what the first run *wrote* is what the second run reads.
		const second = createHarness(
			cfg,
			Object.fromEntries(Object.entries(first.states).map(([id, st]) => [id, st.val])),
		);
		head1.writes.length = 0;
		await second.ready();
		await second.poll(1);
		expect(
			head1.writes.some(w => w.IS === 2400),
			'the second run must finish it',
		).to.equal(true);
		await second.unload();
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
			{ 'info.gsOwned': true, 'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]) },
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

	it('writes the binding record when it creates a binding', async () => {
		// The reader has a fallback to head 1, so a writer that never runs looks correct
		// in every test that presets the state by hand.
		const h = createHarness({
			head1Host: `127.0.0.1:${head1.port}`,
			controlMode: 'device',
			meterType: 'ecotracker',
			meterId: '192.168.1.99',
			pollInterval: 3600,
			requestTimeout: 2000,
		});
		await h.ready();
		expect(h.states['info.meterBound']?.val).to.equal(true);
		expect(JSON.parse(String(h.states['info.meterBoundHosts']?.val))).to.deep.equal([`127.0.0.1:${head1.port}`]);
		await h.unload();
	});

	it('matches the binding retry by host, not by head number', async () => {
		// Head 2 carries the binding. A retry that keys on "head 1" releases the wrong
		// device and leaves the real one bound.
		const head2 = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					head2Host: `127.0.0.1:${head2.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${head2.port}`]) },
			);
			head2.dead = true; // the startup release cannot land, so the retry has work
			await h.ready();
			head2.dead = false;
			head1.writes.length = 0;
			head2.writes.length = 0;
			await h.poll(1); // the wrong head must not be touched
			expect(
				head1.writes.some(w => 'MM' in w),
				'head 1 must be left alone',
			).to.equal(false);
			await h.poll(2);
			expect(
				head2.writes.some(w => w.MM === 0),
				'the bound head must be released',
			).to.equal(true);
			await h.unload();
		} finally {
			await head2.close();
		}
	});

	it('does not retry a removed head on every single poll', async () => {
		// A host with no poll of its own rides along on the others. Without a throttle
		// that is one extra request per poll cycle, forever.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // never reachable: the job stays outstanding throughout
			await h.ready();
			gone.requests = 0;
			// Attempts, not landed writes: a host that keeps failing is exactly the one
			// the throttle is for, and nothing it receives would show up in `writes`.
			await h.poll(1);
			await h.poll(1);
			await h.poll(1);
			expect(gone.requests, 'the startup attempt covers this interval').to.equal(0);
			// Once the interval has passed, exactly one more — however many polls arrive.
			h.instance.lastForeignRetry = 0;
			await h.poll(1);
			await h.poll(1);
			await h.poll(1);
			expect(gone.requests, 'one attempt per interval, not per poll').to.equal(1);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('reports a recorded host that stays unreachable instead of retrying in silence', async () => {
		// The claim deliberately never expires — a setpoint we cannot confirm as cleared
		// must outlive the run. That makes it the one state the adapter cannot leave on
		// its own, so the operator has to be told which host is holding it open.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true;
			await h.ready();
			for (let i = 0; i < 12; i++) {
				h.instance.lastForeignRetry = 0; // as the throttle expiring would
				await h.instance.retryForeignCleanup();
			}
			const warned = h.logs.filter(l => l.level === 'warn' && l.message.includes('info.gsOwnedHosts'));
			expect(warned.length, 'exactly one report, not one per attempt').to.equal(1);
			expect(warned[0].message).to.contain(`127.0.0.1:${gone.port}`);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('stops the removed-head retry once the shutdown has begun', async () => {
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true;
			await h.ready();
			gone.dead = false;
			await h.unload();
			gone.writes.length = 0;
			await h.poll(1); // a poll that was already in flight resumes here
			expect(gone.writes, 'nothing may be written after the shutdown').to.deep.equal([]);
			// Asserted directly as well: the gate inside the retry is reached only when
			// something calls it without going through retryGsCleanup, which returns on
			// `stopping` first. Going through the poll alone would leave it unconstrained.
			await h.instance.retryForeignCleanup();
			expect(gone.writes, 'not even when called directly').to.deep.equal([]);
		} finally {
			await gone.close();
		}
	});

	it('recognises a recorded host that was re-typed with a scheme or a slash', async () => {
		// The record holds whatever the previous run's configuration said. A purely
		// cosmetic edit in between made the head look removed — so it was written to as
		// a stranger while the real one was treated as never having carried a setpoint.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.gsOwned': true,
				'info.gsOwnedHosts': JSON.stringify([`http://127.0.0.1:${head1.port}/`]),
			},
		);
		head1.dead = true; // unreachable at startup, so the job stays outstanding
		await h.ready();
		head1.dead = false;
		// The retry is driven by the head's own poll and matched against the recorded
		// list. Comparing the raw strings leaves the polling head unrecognised, so the
		// job is never finished and the record never clears.
		await h.poll(1);
		expect(
			head1.writes.some(w => w.GS === 0),
			'the polling head must be recognised in the record',
		).to.equal(true);
		expect(h.states['info.gsOwned']?.val, 'and the job must count as finished').to.equal(false);
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
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
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
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
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

	it('releases an old binding when it starts in controller mode', async () => {
		// Controller mode clears MM on the configured heads, which says nothing about a
		// device that is no longer among them and still carries our binding.
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			await h.ready();
			expect(
				other.writes.some(w => w.MM === 0),
				'the unconfigured device must be released',
			).to.equal(true);
			expect(h.states['info.meterBound']?.val).to.equal(false);
			await h.unload();
		} finally {
			await other.close();
		}
	});

	it('keeps retrying a binding on a host that has no poll of its own', async () => {
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			other.dead = true; // the startup release cannot land
			await h.ready();
			expect(h.states['info.meterBound']?.val, 'the record must stay open').to.equal(true);
			other.dead = false;
			other.writes.length = 0;
			h.instance.lastMeterRetry = 0; // as the throttle expiring would
			await h.poll(1); // rides along on the configured head's poll
			expect(
				other.writes.some(w => w.MM === 0),
				'the retry must reach it',
			).to.equal(true);
			expect(h.states['info.meterBound']?.val).to.equal(false);
			await h.unload();
		} finally {
			await other.close();
		}
	});

	it('throttles that retry and reports a host that stays silent', async () => {
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			other.dead = true;
			await h.ready();
			other.requests = 0;
			h.instance.lastMeterRetry = Date.now(); // the interval has just started
			await h.poll(1);
			await h.poll(1);
			await h.poll(1);
			expect(other.requests, 'no attempt while the interval is running').to.equal(0);
			// …and once it has passed, exactly one more, however many polls arrive.
			h.instance.lastMeterRetry = 0;
			await h.poll(1);
			await h.poll(1);
			expect(other.requests, 'one attempt per interval, not per poll').to.equal(1);
			// A host that never answers must be reported once, not once per attempt.
			for (let i = 0; i < 12; i++) {
				h.instance.lastMeterRetry = 0;
				await h.instance.retryForeignMeterRelease();
			}
			const warned = h.logs.filter(l => l.level === 'warn' && l.message.includes('gone for good'));
			expect(warned.length, 'one report, not one per minute').to.equal(1);
			other.dead = false;
			await h.unload();
		} finally {
			await other.close();
		}
	});

	it('does not release the binding it is maintaining in device mode', async () => {
		// A stale entry for a device that cannot be reached keeps the record open, which
		// is what brings the retry into play at all. Without that the "everything on the
		// record is a configured head" shortcut returns first and the device-mode guard
		// is never reached — the test would pass with the guard deleted.
		const gone = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'device',
					meterType: 'ecotracker',
					meterId: '192.168.1.99',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${gone.port}`]) },
			);
			gone.dead = true; // stays on the record through the run
			await h.ready();
			head1.writes.length = 0;
			h.instance.lastMeterRetry = 0;
			await h.instance.retryForeignMeterRelease();
			expect(
				head1.writes.some(w => w.MM === 0),
				'device mode must not release the binding it maintains',
			).to.equal(false);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('stops releasing bindings once the shutdown has begun', async () => {
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			other.dead = true;
			await h.ready();
			other.dead = false;
			await h.unload();
			other.writes.length = 0;
			await h.instance.releaseMeterBindings();
			expect(other.writes, 'nothing may be written after the shutdown').to.deep.equal([]);
		} finally {
			await other.close();
		}
	});

	it('picks up an inherited inverter limit in controller mode too', async () => {
		// The controller only steers IS when the option is on. With it off, a limit left
		// by an earlier run is nobody's job unless this path takes it.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				controllerControlIs: false,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		head1.reported.IS = 0; // throttled shut by the earlier run
		await h.ready();
		head1.writes.length = 0;
		await h.poll(1);
		expect(
			head1.writes.some(w => w.IS === 2400),
			'the limit must be handed back',
		).to.equal(true);
		expect(h.states['info.isOwned']?.val).to.equal(false);
		await h.unload();
	});

	it('keeps an unreachable removed head on the limit claim when the controller starts', async () => {
		// The controller takes the configured heads' limits over. Replacing the claim
		// instead of widening it loses the one device nobody else is going to visit.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					controllerControlIs: true,
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // cannot be released right now
			await h.ready();
			const claim = JSON.parse(String(h.states['info.isOwnedHosts']?.val)) as string[];
			expect(claim, 'the removed head must stay on the claim').to.include(`127.0.0.1:${gone.port}`);
			expect(claim).to.include(`127.0.0.1:${head1.port}`);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('reads the model of a removed head instead of guessing its maximum', async () => {
		// A 500 handed 2400 W would be three times its rating. The head is not configured
		// any more, so the only way to know is to ask it.
		const gone = await startHead({ MG: 800, IS: 0 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 2000,
				},
				{
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
				},
			);
			await h.ready();
			const released = gone.writes.find(w => 'IS' in w);
			expect(released?.IS, 'the real maximum, not the default').to.equal(800);
			expect(h.states['info.isOwned']?.val).to.equal(false);
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('retries a removed head whose limit could not be handed back', async () => {
		const gone = await startHead({ MG: 800, IS: 0 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // unreachable at startup
			await h.ready();
			expect(h.states['info.isOwned']?.val, 'the claim must stay open').to.equal(true);
			gone.dead = false;
			h.instance.lastIsRetry = 0;
			await h.poll(1); // rides along on the configured head's poll
			expect(
				gone.writes.some(w => w.IS === 800),
				'the retry must finish the job',
			).to.equal(true);
			expect(h.states['info.isOwned']?.val).to.equal(false);
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('survives a single rejected state write when clearing the limit claim', async () => {
		// The claim update is serialised through one promise chain. A chain that is left
		// rejected never runs another callback, so one busy moment in the states DB would
		// turn into a permanent inability to close the claim — and the limit would be
		// written again on every poll for the rest of the run.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		head1.reported.IS = 0;
		await h.ready();
		h.failNextStateWrite('info.isOwned'); // one hiccup while closing the claim
		await h.poll(1);
		head1.writes.length = 0;
		for (let i = 0; i < 4; i++) {
			await h.poll(1);
		}
		expect(
			head1.writes.filter(w => 'IS' in w).length,
			'one hiccup must not make every later poll write the limit again',
		).to.equal(1);
		expect(h.states['info.isOwned']?.val, 'and the claim must close').to.equal(false);
		await h.unload();
	});

	it('retries a limit release that failed once', async () => {
		// The pending record is cleared before the write so two overlapping polls cannot
		// both release. A failed write has to put it back, or that head keeps its
		// throttled limit for the rest of the run.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 300,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		head1.reported.IS = 0;
		await h.ready();
		head1.dead = true;
		await h.poll(1); // the release cannot land
		head1.dead = false;
		head1.writes.length = 0;
		await h.poll(1);
		expect(
			head1.writes.some(w => w.IS === 2400),
			'a failed release must be tried again',
		).to.equal(true);
		await h.unload();
	});

	it('does not lose one of two claim updates made at the same moment', async () => {
		// Read-modify-write on one record. Without serialisation the second reader sees
		// the list before the first one wrote, and its update puts the removed host back.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify(['127.0.0.1:1', '127.0.0.1:2']),
			},
		);
		await h.ready();
		await h.instance.setIsOwnedHosts(['127.0.0.1:1', '127.0.0.1:2']);
		await Promise.all([h.instance.clearIsClaim('127.0.0.1:1'), h.instance.clearIsClaim('127.0.0.1:2')]);
		expect(JSON.parse(String(h.states['info.isOwnedHosts']?.val)), 'both removals must survive').to.deep.equal([]);
		await h.unload();
	});

	it('stops the limit retry once the shutdown has begun', async () => {
		const gone = await startHead({ MG: 800, IS: 0 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true;
			await h.ready();
			gone.dead = false;
			await h.unload();
			gone.writes.length = 0;
			h.instance.lastIsRetry = 0;
			await h.instance.retryForeignIsRelease();
			expect(gone.writes, 'nothing may be written after the shutdown').to.deep.equal([]);
		} finally {
			await gone.close();
		}
	});

	it('leaves the limits of configured heads to the controller', async () => {
		// With IS steering on, the current heads are on the claim on purpose. A retry
		// that does not skip them reads their model every minute and writes IS to the
		// maximum — straight into the regulation that is steering IS at that moment.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				controllerControlIs: true,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		await h.ready();
		await h.poll(1);
		head1.writes.length = 0;
		h.instance.lastIsRetry = 0;
		await h.instance.retryForeignIsRelease();
		expect(
			head1.writes.some(w => 'IS' in w),
			'a head the controller steers must not be touched by the retry',
		).to.equal(false);
		await h.unload();
	});

	it('forgets a binding failure once the release lands', async () => {
		// The counter decides when the ten-minute report fires. Carrying it across a
		// success means the next outage is reported under the previous one's tally, and
		// its first failure is logged as a repeat.
		const other = await startHead({ MM: 1 });
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{ 'info.meterBound': true, 'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${other.port}`]) },
			);
			other.dead = true;
			await h.ready(); // failure 1 recorded
			other.dead = false;
			h.instance.lastMeterRetry = 0;
			await h.instance.retryForeignMeterRelease(); // succeeds
			expect(h.instance.meterRetryFailures.size, 'the record must be closed').to.equal(0);
			await h.unload();
		} finally {
			await other.close();
		}
	});

	it('settles the unconfigured hosts in one step, not three', async () => {
		// Grid setpoint, meter binding and inverter limit can all point at a host that is
		// gone. Waiting each one out in turn meant up to three request timeouts before
		// the heads that *are* connected got their neutral setpoint — with the 8 s
		// default, 24 s of an inherited setpoint running unwatched.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 500,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
					'info.meterBound': true,
					'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // holds every connection open for its full timeout
			await h.ready();
			expect(gone.requests, 'all three jobs must reach it').to.be.greaterThan(2);
			expect(gone.peakConcurrent, 'and they must wait together, not one after another').to.be.greaterThan(1);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('does not retry straight after the startup attempt', async () => {
		// All three retry clocks start at zero, so the first poll — milliseconds after
		// the startup tried and failed — passed the interval check and tried again. One
		// extra connection to a device that has just refused one, at every start.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'off',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
					'info.isOwned': true,
					'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
					'info.meterBound': true,
					'info.meterBoundHosts': JSON.stringify([`127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // every job fails and stays outstanding
			await h.ready();
			gone.requests = 0;
			await h.poll(1);
			await h.poll(1);
			expect(gone.requests, 'the startup attempt counts as this interval’s attempt').to.equal(0);
			gone.dead = false;
			await h.unload();
		} finally {
			await gone.close();
		}
	});

	it('releases the inverter limit once, even with two polls in flight', async () => {
		// The head's own poll and the staggered start-up poll overlap routinely. Checking
		// the pending record, awaiting the write and only then clearing it lets both
		// callers through — two requests to a device whose socket table has few slots.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'off',
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		head1.reported.IS = 0;
		await h.ready();
		head1.writes.length = 0;
		head1.delayMs = 40; // widen the window the two callers share
		await Promise.all([h.poll(1), h.poll(1)]);
		head1.delayMs = 0;
		expect(head1.writes.filter(w => 'IS' in w).length, 'the limit must go out once').to.equal(1);
		await h.unload();
	});

	it('reads the limit claim from the record, not from the current option', async () => {
		// On shutdown as on startup: whether a throttled limit is standing is a fact from
		// the past. With the option off and a claim open, it still has to be handed back.
		const h = createHarness(
			{
				head1Host: `127.0.0.1:${head1.port}`,
				controlMode: 'controller',
				gridPowerStateId: 'shelly.0.total',
				controllerControlIs: false,
				pollInterval: 3600,
				requestTimeout: 2000,
			},
			{
				'info.isOwned': true,
				'info.isOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`]),
			},
		);
		await h.ready();
		await h.poll(1); // the model is known from here on
		// resumeIsOwnership() already handed it back; re-open the claim so only the
		// shutdown path can satisfy this.
		await h.instance.setIsOwnedHosts([`127.0.0.1:${head1.port}`]);
		head1.writes.length = 0;
		await h.unload();
		// Both fields in one write: that is the shutdown neutralisation specifically.
		// Asserting on "some IS write" passed even when the shutdown ignored the record,
		// because a release from the poll path satisfied it.
		expect(
			head1.writes.some(w => w.GS === 0 && w.IS === 2400),
			'the shutdown must go by the record',
		).to.equal(true);
	});

	it('honours a host the operator struck from the record', async () => {
		// The ten-minute warning tells them to do exactly this. If the in-memory list
		// wins, the next clean stop writes the host straight back and the message returns
		// forever.
		const gone = await startHead();
		try {
			const h = createHarness(
				{
					head1Host: `127.0.0.1:${head1.port}`,
					controlMode: 'controller',
					gridPowerStateId: 'shelly.0.total',
					pollInterval: 3600,
					requestTimeout: 300,
				},
				{
					'info.gsOwned': true,
					'info.gsOwnedHosts': JSON.stringify([`127.0.0.1:${head1.port}`, `127.0.0.1:${gone.port}`]),
				},
			);
			gone.dead = true; // stays outstanding through the run
			await h.ready();
			// The operator decides that device is gone and strikes it.
			h.states['info.gsOwnedHosts'] = {
				val: JSON.stringify([`127.0.0.1:${head1.port}`]),
				ack: true,
			};
			gone.requests = 0;
			h.instance.lastForeignRetry = 0;
			await h.instance.retryForeignCleanup();
			expect(gone.requests, 'a struck host must not be tried again').to.equal(0);
			await h.unload();
			const recorded = JSON.parse(String(h.states['info.gsOwnedHosts']?.val)) as string[];
			expect(recorded, 'and must not be written back on the way out').to.not.include(`127.0.0.1:${gone.port}`);
			gone.dead = false;
		} finally {
			await gone.close();
		}
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
