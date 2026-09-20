/**
 * Unit tests for the device HTTP client, against a real local server.
 *
 * The focus is the failure paths: a head that dies mid-response or never answers
 * must never leave a caller waiting, because the poll loop, the control writes and
 * the failsafe all await these promises.
 */

import { expect } from 'chai';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { SunEnergyXtApi } from './api';

/** Minimal TimerHost backed by plain node timers. */
const timers = {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as ioBroker.Timeout,
	clearTimeout: (t?: ioBroker.Timeout) => clearTimeout(t as unknown as NodeJS.Timeout),
	log: { debug: () => undefined, warn: () => undefined, info: () => undefined, error: () => undefined },
} as unknown as ConstructorParameters<typeof SunEnergyXtApi>[2];

/**
 * Starts a one-off server with the given handler and returns its port plus a stop fn.
 *
 * @param handler request handler for every request the test makes
 */
async function serve(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

describe('SunEnergyXtApi', () => {
	it('reads a normal snapshot', async () => {
		const srv = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ state: { reported: { GP: -1500, SC: 54 } } }));
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 2000, timers);
		try {
			const { reported } = await api.read();
			expect(reported.GP).to.equal(-1500);
		} finally {
			api.destroy();
			await srv.close();
		}
	});

	it('rejects when the head dies mid-response instead of hanging', async () => {
		// Announces 500 bytes, sends a fragment, then kills the socket. Neither 'end'
		// nor a request 'error' fires here, so without explicit response-side handling
		// the promise would never settle.
		const srv = await serve((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
			res.write('{"state":{"reported":{"GP":');
			setTimeout(() => res.socket?.destroy(), 10);
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 5000, timers);
		try {
			const started = Date.now();
			await expectRejection(api.read());
			// Must fail on the abort, not by running into the 5 s deadline.
			expect(Date.now() - started).to.be.lessThan(2000);
		} finally {
			api.destroy();
			await srv.close();
		}
	});

	it('rejects on the deadline when the head never answers', async () => {
		const srv = await serve(() => {
			/* accept the request and stay silent */
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 150, timers);
		try {
			const err = await expectRejection(api.read());
			expect(err.message).to.equal('Timeout');
		} finally {
			api.destroy();
			await srv.close();
		}
	});

	it('rejects a non-2xx status', async () => {
		const srv = await serve((_req, res) => {
			res.writeHead(500);
			res.end('boom');
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 2000, timers);
		try {
			const err = await expectRejection(api.read());
			expect(err.message).to.contain('500');
		} finally {
			api.destroy();
			await srv.close();
		}
	});

	it('serializes requests per head and still settles them all', async () => {
		// maxSockets is 1, so these queue behind each other; a stuck one must not
		// strand the rest.
		let n = 0;
		const srv = await serve((_req, res) => {
			const mine = ++n;
			setTimeout(
				() => {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ state: { reported: { GP: mine } } }));
				},
				mine === 1 ? 60 : 0,
			);
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 3000, timers);
		try {
			const results = await Promise.all([api.read(), api.read(), api.read()]);
			expect(results.map(r => r.reported.GP).sort()).to.deep.equal([1, 2, 3]);
		} finally {
			api.destroy();
			await srv.close();
		}
	});

	it('keeps at most one connection open per head', async () => {
		// The heads run an ESP32 with very few socket slots, and a close that is lost on
		// a weak link takes one out for good. The client serialises requests and closes
		// each connection, so overlapping calls must not open a second socket — an
		// invariant the suite asserted nowhere, because a request that succeeds looks the
		// same either way.
		let open = 0;
		let peak = 0;
		const srv = await serve((req, res) => {
			open++;
			peak = Math.max(peak, open);
			req.on('data', () => undefined);
			req.on('end', () => undefined);
			setTimeout(() => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ state: { reported: { GP: 0 } } }));
				open--;
			}, 40);
		});
		const api = new SunEnergyXtApi(`127.0.0.1:${srv.port}`, 2000, timers);
		try {
			// Fired together on purpose: a poll and a control write racing each other is
			// the case that would otherwise open a second socket.
			await Promise.all([api.read(), api.write({ GS: 0 }), api.read(), api.write({ GS: 100 })]);
			expect(peak, 'never two sockets at once').to.equal(1);
		} finally {
			api.destroy();
			await srv.close();
		}
	});
});

/**
 * Awaits a promise that must reject, and returns the error.
 *
 * @param p the promise under test
 */
async function expectRejection(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected the promise to reject, but it resolved');
}
