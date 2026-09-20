/*
 * Minimal HTTP client for the SunEnergyXT 500 local API.
 *
 * Endpoints (see docs SunEnergyXT_API.de.md):
 *   GET  /read   → {"state":{"reported":{...}}}  — read the snapshot from state.reported
 *   POST /write  → {"state":{FIELD: value}}       — partial desired-state write
 *
 * /write is an asynchronous desired-state model: HTTP 2xx only means the request
 * was accepted. The actual result must be confirmed by reading /read again.
 *
 * Uses the Node.js http module directly so the adapter has no runtime dependencies.
 */

import * as http from 'node:http';
import { URL } from 'node:url';

/** Decoded contents of `state.reported` from /read. Unknown keys are tolerated. */
export type ReportedState = Record<string, unknown>;

/** Upper bound for a device response; a real /read is a few KB. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Result of a /read: the decoded reported state plus the original response body. */
export interface DeviceRead {
	/** The decoded `state.reported` snapshot. */
	reported: ReportedState;
	/** The raw, unmodified /read response body as returned by the device. */
	body: string;
}

/**
 * The slice of the adapter this client needs: its timer functions. ioBroker tracks
 * timers created this way and clears them on unload, so a request deadline can never
 * outlive the adapter instance (plain setTimeout would — see check S5005).
 *
 * Declared as property signatures rather than methods on purpose: repochecker's
 * S5005 matches the literal `setTimeout(`, so a method signature here is reported
 * as a plain timer call even though no such call exists.
 */
export interface TimerHost {
	/** Starts an adapter-managed timeout. */
	setTimeout: (cb: () => void, ms: number) => ioBroker.Timeout | undefined;
	/** Cancels a timer returned by {@link TimerHost.setTimeout}. */
	clearTimeout: (timer: ioBroker.Timeout | undefined) => void;
}

/** Minimal HTTP client for one head's local API (/read and /write). */
export class SunEnergyXtApi {
	private readonly baseUrl: string;
	/**
	 * A dedicated connection pool per head instead of Node's global agent:
	 *
	 * - `keepAlive: false` makes every request send `Connection: close` and tears the
	 *   socket down afterwards. The global agent keeps a socket open for 5 s, which at
	 *   a 5 s poll means permanently — and the ESP32 in the head has a very small
	 *   socket table it cannot reclaim if the close is lost on a weak Wi-Fi link.
	 * - `maxSockets: 1` serializes this head's requests: a control write is queued
	 *   behind a running poll instead of opening a second parallel connection.
	 */
	private readonly agent: http.Agent;

	/**
	 * @param host - device IP or hostname (with or without scheme)
	 * @param timeoutMs - request timeout in milliseconds
	 * @param timers - adapter instance supplying the managed timer functions
	 */
	public constructor(
		host: string,
		private readonly timeoutMs: number,
		private readonly timers: TimerHost,
	) {
		const trimmed = (host || '').trim().replace(/\/+$/, '');
		this.baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
		this.agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
	}

	/** Closes all sockets of this head's pool (adapter unload). */
	public destroy(): void {
		this.agent.destroy();
	}

	/** Reads the current device snapshot (decoded `state.reported`) plus the original body. */
	public async read(): Promise<DeviceRead> {
		const body = await this.request('GET', '/read');
		const parsed: unknown = JSON.parse(body);
		if (!isPlainObject(parsed)) {
			// Arrays and primitives are not snapshots. Accepting them would make a head
			// look online with every field missing, which downstream defaults then turn
			// into plausible-looking zeros.
			throw new Error('Unexpected /read response structure');
		}
		if ('state' in parsed) {
			// Envelope shape: then the payload has to be inside it. Falling back to the
			// envelope itself would hand the caller a snapshot with no fields at all.
			const state = (parsed as { state?: unknown }).state;
			const reported = isPlainObject(state) ? (state as { reported?: unknown }).reported : undefined;
			if (!isPlainObject(reported)) {
				throw new Error('Unexpected /read response structure');
			}
			return { reported: reported, body };
		}
		// Some firmware branches may return the snapshot directly.
		return { reported: parsed, body };
	}

	/**
	 * Writes one or more target fields partially under `state`.
	 * Resolves on HTTP 2xx; the caller must confirm the effect via read().
	 *
	 * @param fields - map of API field name to value
	 * @param timeoutMs - deadline for this write; defaults to the configured request
	 * timeout. Regulation writes pass a shorter one, because a setpoint that takes
	 * longer than a control cycle to arrive is stale by the time it lands.
	 */
	public async write(fields: Record<string, string | number>, timeoutMs?: number): Promise<void> {
		await this.request('POST', '/write', JSON.stringify({ state: fields }), timeoutMs);
	}

	/**
	 * Arms the request deadline and returns a canceller.
	 *
	 * Prefers the adapter's managed timer so the timeout is cleaned up with the
	 * instance. That timer refuses to start once ioBroker has begun shutting the
	 * adapter down, though — and the unload path still issues writes (neutralising the
	 * heads). Falling back to a plain timer there keeps those last requests bounded
	 * instead of letting them hang until the process is killed.
	 *
	 * @param onDeadline invoked when the timeout expires
	 * @param timeoutMs deadline for this request
	 */
	private armDeadline(onDeadline: () => void, timeoutMs: number): () => void {
		const managed = this.timers.setTimeout(onDeadline, timeoutMs);
		if (managed !== undefined) {
			return () => this.timers.clearTimeout(managed);
		}
		const plain = setTimeout(onDeadline, timeoutMs);
		return () => clearTimeout(plain);
	}

	private request(
		method: 'GET' | 'POST',
		path: string,
		payload?: string,
		timeoutMs = this.timeoutMs,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const url = new URL(path, this.baseUrl);
			// Explicit, although keepAlive:false already implies it — the head should
			// reclaim the socket as soon as the response is out.
			const headers: http.OutgoingHttpHeaders = { Connection: 'close' };
			if (payload !== undefined) {
				headers['Content-Type'] = 'application/json';
				headers['Content-Length'] = Buffer.byteLength(payload);
			}
			let settled = false;
			// Holder so settle() can clear a timer that is only armed further below
			// (it needs the request object, which does not exist yet).
			const pending: { clear?: () => void } = {};
			const settle = (err?: Error, data?: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				pending.clear?.();
				if (err) {
					reject(err);
				} else {
					resolve(data ?? '');
				}
			};
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port || 80,
					path: url.pathname + url.search,
					method,
					headers,
					agent: this.agent,
				},
				res => {
					let data = '';
					let ended = false;
					res.on('data', chunk => {
						data += chunk;
						if (data.length > MAX_RESPONSE_BYTES) {
							req.destroy(new Error('Response too large'));
						}
					});
					res.on('end', () => {
						ended = true;
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							settle(new Error(`HTTP ${status}`));
							return;
						}
						settle(undefined, data);
					});
					// A head that dies mid-response emits neither 'end' here nor 'error' on
					// the request — without these two the promise would never settle and the
					// caller (poll, control write, failsafe) would wait forever.
					res.on('error', e => settle(e));
					res.on('close', () => {
						if (!ended) {
							settle(new Error('Response closed before it finished'));
						}
					});
				},
			);
			// The whole request, not req.setTimeout(), which starts only once a socket is
			// assigned — with maxSockets 1 a request also waits behind a stuck one.
			// It settles the promise before tearing the socket down: req.destroy() on an
			// already-destroyed request emits no 'error', which would strand the caller.
			pending.clear = this.armDeadline(() => {
				settle(new Error('Timeout'));
				req.destroy();
			}, timeoutMs);
			req.on('error', e => settle(e));
			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}
}

/**
 * True for a JSON object that can carry device fields — not null, not an array.
 *
 * @param v parsed JSON value
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
