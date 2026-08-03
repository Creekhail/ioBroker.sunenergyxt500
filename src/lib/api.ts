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

/** Envelope structure of a /read response. */
type ReadEnvelope = {
	/** Device-shadow container. */
	state?: {
		/** The reported snapshot inside the shadow. */
		reported?: ReportedState;
	};
};

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
	 */
	public constructor(
		host: string,
		private readonly timeoutMs: number,
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
		const parsed = JSON.parse(body) as ReadEnvelope;
		const reported = parsed?.state?.reported;
		if (reported && typeof reported === 'object') {
			return { reported, body };
		}
		// Some firmware branches may return the snapshot directly
		if (parsed && typeof parsed === 'object') {
			return { reported: parsed, body };
		}
		throw new Error('Unexpected /read response structure');
	}

	/**
	 * Writes one or more target fields partially under `state`.
	 * Resolves on HTTP 2xx; the caller must confirm the effect via read().
	 *
	 * @param fields - map of API field name to value
	 */
	public async write(fields: Record<string, string | number>): Promise<void> {
		await this.request('POST', '/write', JSON.stringify({ state: fields }));
	}

	private request(method: 'GET' | 'POST', path: string, payload?: string): Promise<string> {
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
			const pending: { deadline?: NodeJS.Timeout } = {};
			const settle = (err?: Error, data?: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(pending.deadline);
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
					res.on('data', chunk => {
						data += chunk;
						if (data.length > MAX_RESPONSE_BYTES) {
							req.destroy(new Error('Response too large'));
						}
					});
					res.on('end', () => {
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							settle(new Error(`HTTP ${status}`));
							return;
						}
						settle(undefined, data);
					});
				},
			);
			// One deadline for the whole request rather than req.setTimeout(), which only
			// starts once a socket is assigned: with maxSockets 1 a request can also spend
			// time queued behind a stuck one, and that wait must count against the timeout.
			pending.deadline = setTimeout(() => req.destroy(new Error('Timeout')), this.timeoutMs);
			pending.deadline.unref();
			req.on('error', e => settle(e));
			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}
}
