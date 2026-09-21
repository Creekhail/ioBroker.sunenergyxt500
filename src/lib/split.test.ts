/**
 * Unit tests for the pure multi-head allocation logic (no hardware needed).
 */

import { expect } from 'chai';
import { computeIsTarget, computeTotalTarget, type HeadState, splitTarget } from './split';

/**
 * Build a head with sensible defaults (PRO: 2400 W, half full).
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
		maxCharge: 2400,
		maxInverter: 2400,
		lp: 0,
		pv: 0,
		socHysteresisDischarge: 5,
		socHysteresisCharge: 5,
		...partial,
	};
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

/**
 * Extract the GS values from an already computed split.
 *
 * @param setpoints Result of splitTarget.
 */
function setpointsOf(setpoints: { index: number; gs: number }[]): number[] {
	return setpoints.map(r => r.gs);
}

describe('computeTotalTarget', () => {
	it('follows grid draw (discharge) and feed-in (charge)', () => {
		expect(computeTotalTarget(0, 200, 1, 4800, 4800)).to.equal(200);
		expect(computeTotalTarget(0, -1000, 1, 4800, 4800)).to.equal(-1000);
	});

	it('adds the proportional term on top of the reported grid power (anti-windup)', () => {
		expect(computeTotalTarget(500, 100, 1, 4800, 4800)).to.equal(600);
	});

	it('clamps to the summed power limit in both directions', () => {
		expect(computeTotalTarget(0, 99999, 1, 4800, 4800)).to.equal(4800);
		expect(computeTotalTarget(0, -99999, 1, 4800, 4800)).to.equal(-4800);
	});

	it('uses the charge limit for a negative result, whatever the sign of the error', () => {
		// The case both reviews found: a positive error only means "raise the setpoint".
		// While charging below the export cap the result stays negative and still needs
		// the charge bound — clamping it to the export sum cut −2000 W down to −800 W.
		expect(computeTotalTarget(-2000, 100, 1, 800, 2400)).to.equal(-1900);
		expect(computeTotalTarget(-2000, 300, 1, 800, 2400)).to.equal(-1700);
	});

	it('still clamps a negative result at the charge limit', () => {
		expect(computeTotalTarget(-2000, -1000, 1, 800, 2400)).to.equal(-2400);
	});

	it('clamps a positive result at the export limit, not the charge limit', () => {
		expect(computeTotalTarget(0, 5000, 1, 800, 2400)).to.equal(800);
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
	it('charges a head whose export cap is lower than its charge limit', () => {
		// The case both reviews found independently: MG caps the output, not the intake.
		// Capping charge at MG left a 500 — or a PRO whose owner set MG to 800 — taking
		// a third of what it may, with the surplus going to the grid.
		const heads = [head({ index: 1, maxPower: 800, maxCharge: 2400 })];
		expect(splitTarget(-2000, heads)[0].gs).to.equal(-2000);
	});

	it('caps each head at its charge limit when the target exceeds them all', () => {
		// The charge-side counterpart of the export cap test. Every charging test so far
		// asked for less than one head can take, so the negative per-head cap was never
		// exercised — removing it entirely left the suite green.
		const heads = [head({ index: 1 }), head({ index: 2 })];
		expect(gs(heads, -6000)).to.deep.equal([-2400, -2400]);
	});

	it('caps a head at its own charge limit, not the export one', () => {
		const heads = [head({ index: 1, maxPower: 800, maxCharge: 2400 })];
		expect(gs(heads, -6000)).to.deep.equal([-2400]);
	});

	it('still caps discharging at the export limit', () => {
		const heads = [head({ index: 1, maxPower: 800, maxCharge: 2400 })];
		expect(splitTarget(2000, heads)[0].gs).to.equal(800);
	});
});

describe('computeIsTarget', () => {
	it('mirrors the discharge part of GS when no load port is wired', () => {
		expect(computeIsTarget(head({ index: 1 }), 800)).to.equal(800);
	});

	it('goes to the device minimum while charging', () => {
		// GS < 0 means drawing from the grid — the inverter should not output anything.
		// The floor is 1, not 0: the device documents IS as 1..2400 and a manual 0 is
		// refused, so the controller must not write one either.
		expect(computeIsTarget(head({ index: 1 }), -800)).to.equal(1);
	});

	it('adds the local load on top of the grid-port share', () => {
		// 600 W leaving via the grid port plus 300 W drawn by the local load: the
		// inverter has to be allowed to produce both.
		expect(computeIsTarget(head({ index: 1, lp: 300 }), 600)).to.equal(900);
	});

	it('still covers the local load while charging', () => {
		expect(computeIsTarget(head({ index: 1, lp: 300 }), -500)).to.equal(300);
	});

	it('caps to PV once the head is at its discharge floor', () => {
		// soc == socMin: anything beyond the current PV yield could only come out of a
		// battery that has already reached its minimum.
		const h = head({ index: 1, soc: 10, socMin: 10, lp: 400, pv: 150 });
		expect(computeIsTarget(h, 600)).to.equal(150);
	});

	it('goes to the device minimum at the discharge floor without PV', () => {
		const h = head({ index: 1, soc: 5, socMin: 10, lp: 400, pv: 0 });
		expect(computeIsTarget(h, 600)).to.equal(1);
	});

	it('never computes a limit the device would refuse', () => {
		// Whatever the inputs, the result has to stay inside the documented 1..2400.
		for (const gs of [-5000, -1, 0, 1, 5000]) {
			for (const lp of [-500, 0, 300]) {
				for (const pv of [0, 900]) {
					const h = head({ index: 1, soc: 5, socMin: 10, lp, pv });
					const is = computeIsTarget(h, gs);
					expect(is, `gs=${gs} lp=${lp} pv=${pv}`).to.be.at.least(1);
					expect(is).to.be.at.most(2400);
				}
			}
		}
	});

	it('never exceeds the inverter limit', () => {
		const h = head({ index: 1, maxInverter: 800, lp: 500 });
		expect(computeIsTarget(h, 800)).to.equal(800);
	});

	it('is not throttled by a lowered export cap', () => {
		// MG caps what the head feeds into the grid; the inverter also serves the load
		// port. Capping IS at MG left a head whose owner set MG to the legal plug-in
		// limit unable to supply its own load.
		const h = head({ index: 1, maxPower: 800, maxInverter: 2400, lp: 1200 });
		expect(computeIsTarget(h, 0)).to.equal(1200);
	});

	it('ignores a negative load-port reading (back-feed into the port)', () => {
		expect(computeIsTarget(head({ index: 1, lp: -200 }), 500)).to.equal(500);
	});
});

describe('splitTarget SoC hysteresis', () => {
	it('keeps a head out until it clears the device hysteresis band', () => {
		// The device itself refuses to resume at exactly its limit — it waits for the
		// charge to move SI1/SA1 back inside. Commanding power inside that band makes the
		// loop integrate to the limit, get corrected, and start over, writing constantly.
		const h = head({ index: 1, soc: 7, socMin: 5, socHysteresisDischarge: 5 });
		expect(setpointsOf(splitTarget(1000, [h], new Set([1])))).to.deep.equal([0]);
		// Same state, but the head was not saturated before: no band applies.
		expect(setpointsOf(splitTarget(1000, [h]))).to.deep.equal([1000]);
	});

	it('lets a saturated head back in once it is past the band', () => {
		const h = head({ index: 1, soc: 11, socMin: 5, socHysteresisDischarge: 5 });
		expect(setpointsOf(splitTarget(1000, [h], new Set([1])))).to.deep.equal([1000]);
	});

	it('applies the band on the charging side too', () => {
		const h = head({ index: 1, soc: 97, socMax: 100, socHysteresisCharge: 5 });
		expect(setpointsOf(splitTarget(-1000, [h], new Set([1])))).to.deep.equal([0]);
		expect(setpointsOf(splitTarget(-1000, [head({ index: 1, soc: 94, socMax: 100 })], new Set([1])))).to.deep.equal(
			[-1000],
		);
	});

	it('uses the discharge band for discharging and the charge band for charging', () => {
		// The device keeps two separate bands. Collapsing them to one (e.g. their max)
		// would hold a head back from discharging because of a charge-side setting.
		const h = head({
			index: 1,
			soc: 8,
			socMin: 5,
			socMax: 100,
			socHysteresisDischarge: 2,
			socHysteresisCharge: 20,
		});
		// Discharging: only the 2 % band applies, 8 > 5+2 → allowed.
		expect(setpointsOf(splitTarget(1000, [h], new Set([1])))).to.deep.equal([1000]);
		// Charging with a wide charge band: 8 < 100-20 → still allowed.
		expect(setpointsOf(splitTarget(-1000, [h], new Set([1])))).to.deep.equal([-1000]);
		// Near the ceiling the charge band holds it back while the discharge band would not.
		const full = head({ ...h, index: 1, soc: 85 });
		expect(setpointsOf(splitTarget(-1000, [full], new Set([1])))).to.deep.equal([0]);
	});

	it('ignores a negative or absent hysteresis', () => {
		const h = head({ index: 1, soc: 6, socMin: 5, socHysteresisDischarge: -5 });
		expect(setpointsOf(splitTarget(1000, [h], new Set([1])))).to.deep.equal([1000]);
	});
});
