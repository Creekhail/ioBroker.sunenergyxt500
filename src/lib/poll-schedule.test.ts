/*
 * Unit tests for the per-head poll scheduling.
 */
import { expect } from 'chai';
import { POLL_BACKOFF_MAX_MS, pollBackoffMs, pollStaggerMs } from './poll-schedule';

describe('pollStaggerMs', () => {
	it('does not offset a single head', () => {
		expect(pollStaggerMs(1, 1, 5000)).to.equal(0);
	});

	it('spreads heads by up to one second', () => {
		expect(pollStaggerMs(1, 2, 5000)).to.equal(0);
		expect(pollStaggerMs(2, 2, 5000)).to.equal(1000);
		expect(pollStaggerMs(3, 3, 5000)).to.equal(2000);
	});

	it('keeps the offsets inside a short interval', () => {
		// 1 s interval, 3 heads → 333 ms apart, so the last head still polls in time.
		expect(pollStaggerMs(3, 3, 1000)).to.equal(666);
		expect(pollStaggerMs(3, 3, 1000)).to.be.below(1000);
	});
});

describe('pollBackoffMs', () => {
	it('uses the plain interval while the head answers', () => {
		expect(pollBackoffMs(5000, 0)).to.equal(5000);
	});

	it('does not slow down on the very first failure', () => {
		expect(pollBackoffMs(5000, 1)).to.equal(5000);
	});

	it('doubles per consecutive failure', () => {
		expect(pollBackoffMs(5000, 2)).to.equal(10000);
		expect(pollBackoffMs(5000, 3)).to.equal(20000);
		expect(pollBackoffMs(5000, 4)).to.equal(40000);
	});

	it('stops growing at the cap', () => {
		expect(pollBackoffMs(5000, 5)).to.equal(POLL_BACKOFF_MAX_MS);
		expect(pollBackoffMs(5000, 50)).to.equal(POLL_BACKOFF_MAX_MS);
	});

	it('never polls faster than the configured interval', () => {
		// A configured interval above the cap must not be pulled down to it.
		expect(pollBackoffMs(300000, 9)).to.equal(300000);
	});
});
