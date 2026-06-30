/**
 * Unit tests for the pure multi-head allocation logic (no hardware needed).
 */

import { expect } from 'chai';
import { computeTotalTarget, type HeadState, splitTarget } from './split';

/**
 * Build a head with sensible defaults (PRO: 2400 W, half full).
 *
 * @param partial Overrides merged onto the defaults (index is required).
 */
function head(partial: Partial<HeadState> & { index: number }): HeadState {
	return { online: true, gp: 0, soc: 50, socMin: 10, socMax: 100, maxPower: 2400, ...partial };
}

/**
 * Extract the GS values in head order for easy comparison.
 *
 * @param heads Heads to split across.
 * @param totalTarget Total setpoint to distribute.
 */
function gs(heads: HeadState[], totalTarget: number): number[] {
	return splitTarget(totalTarget, heads).map(r => r.gs);
}

describe('computeTotalTarget', () => {
	it('follows grid draw (discharge) and feed-in (charge)', () => {
		expect(computeTotalTarget(0, 200, 1, 4800)).to.equal(200);
		expect(computeTotalTarget(0, -1000, 1, 4800)).to.equal(-1000);
	});

	it('adds the proportional term on top of the reported grid power (anti-windup)', () => {
		expect(computeTotalTarget(500, 100, 1, 4800)).to.equal(600);
	});

	it('clamps to the summed power limit in both directions', () => {
		expect(computeTotalTarget(0, 99999, 1, 4800)).to.equal(4800);
		expect(computeTotalTarget(0, -99999, 1, 4800)).to.equal(-4800);
	});
});

describe('splitTarget', () => {
	it('collapses to single-head behaviour at N=1', () => {
		expect(gs([head({ index: 1 })], 1500)).to.deep.equal([1500]);
		expect(gs([head({ index: 1 })], -1500)).to.deep.equal([-1500]);
	});

	it('splits evenly across heads (discharge and charge)', () => {
		const heads = [head({ index: 1 }), head({ index: 2 }), head({ index: 3 })];
		expect(gs(heads, 1200)).to.deep.equal([400, 400, 400]);
		expect(gs(heads, -1200)).to.deep.equal([-400, -400, -400]);
	});

	it('gives equal power regardless of SoC (no capacity/percent weighting)', () => {
		// One head is nearly full, the other half full — both still get the same
		// charge power until the fuller one reaches its limit and drops out.
		const heads = [head({ index: 1, soc: 90 }), head({ index: 2, soc: 50 })];
		expect(gs(heads, -1200)).to.deep.equal([-600, -600]);
	});

	it('returns all zero inside the dead band (target 0)', () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		expect(gs(heads, 0)).to.deep.equal([0, 0]);
	});

	it('skips a full head when charging and spreads to the others', () => {
		const heads = [head({ index: 1, soc: 100 }), head({ index: 2 }), head({ index: 3 })];
		expect(gs(heads, -1200)).to.deep.equal([0, -600, -600]);
	});

	it('skips an empty head when discharging', () => {
		const heads = [head({ index: 1, soc: 10 }), head({ index: 2 }), head({ index: 3 })];
		expect(gs(heads, 1200)).to.deep.equal([0, 600, 600]);
	});

	it('respects per-head power caps and redistributes the overflow (mixed models)', () => {
		// A is a 500 (800 W), B is a PRO (2400 W).
		const heads = [head({ index: 1, maxPower: 800 }), head({ index: 2, maxPower: 2400 })];
		expect(gs(heads, 2400)).to.deep.equal([800, 1600]);
	});

	it('excludes an offline head from the split', () => {
		const heads = [head({ index: 1 }), head({ index: 2, online: false }), head({ index: 3 })];
		expect(gs(heads, 1200)).to.deep.equal([600, 0, 600]);
	});

	it('caps every head when the target exceeds the total available power', () => {
		const heads = [head({ index: 1 }), head({ index: 2 })];
		expect(gs(heads, 6000)).to.deep.equal([2400, 2400]);
	});

	it('does nothing when no head has headroom in the requested direction', () => {
		const heads = [head({ index: 1, soc: 100 }), head({ index: 2, soc: 100 })];
		expect(gs(heads, -1000)).to.deep.equal([0, 0]);
	});
});
