/*
 * Pure allocation logic for multi-head control.
 *
 * One control loop runs on the *total* grid power (reusing the single-head law
 * GS = clamp(GP + gain * gridPower, -max, +max) at the aggregate level); the
 * resulting total setpoint is then split across the configured heads here.
 *
 * Allocation is EQUAL power per eligible head (not capacity- or SoC-weighted). The
 * reason is the three-phase use case: at full power every head is capped at its own
 * inverter limit, so the sustained three-phase window is bounded by the head holding
 * the least energy. Charging every head with equal power keeps the stored energy as
 * equal as possible (maximising that minimum) → the longest three-phase discharge
 * window. Capacity-weighting would pour proportionally more into the largest tower,
 * lowering the binding (smallest) energy and shortening that window — so capacity is
 * deliberately NOT used here (it only feeds the aggregate SoC readout elsewhere).
 *
 * A head that has reached its SoC limit in the requested direction (full while
 * charging / empty while discharging) drops out and its share is redistributed to
 * the remaining heads; smaller towers therefore simply saturate sooner. Per-head
 * power caps are respected with the same overflow redistribution.
 *
 * Everything here is pure and free of I/O so it can be unit-tested without hardware
 * (N=1 and, via a tester, N=2 are validated on real devices; N=3 is by design).
 *
 * Sign convention (same as GS/GP): positive = feed-in / discharge to grid,
 * negative = draw / charge from grid.
 */

/** Per-head state the allocator needs to compute a setpoint. */
export interface HeadState {
	/** 1-based head number, used for logging and to map the result back. */
	index: number;
	/**
	 * false if the head is unreachable/faulted. Reachability only — a reachable head is
	 * still written to by the failsafe, which is exactly when that matters.
	 */
	online: boolean;
	/**
	 * false when the head answered but did not deliver the data the control law needs
	 * (SoC and its limits). Such a head is left out of the split rather than regulated
	 * on defaults: without a real SoC, "may still charge" is a guess, not a fact.
	 */
	controllable: boolean;
	/** Reported grid-port power GP in W (+feed-in), used for the aggregate loop. */
	gp: number;
	/** Master state of charge in percent (0..100). */
	soc: number;
	/** Minimum discharge SoC limit in percent (SI/SO). */
	socMin: number;
	/** Maximum charge SoC limit in percent (SA). */
	socMax: number;
	/**
	 * Grid-connected *output* limit in W — the device field MG, which the operator sets
	 * to cap feed-in (e.g. 800 for a plug-in system). Discharge only.
	 */
	maxPower: number;
	/**
	 * Charge limit in W. A separate figure: MG caps what the device puts out, not what
	 * it takes in, and the manufacturer documents drawing as -2400..0 for both models.
	 * Capping charge at MG left a 500, or a PRO with MG set to 800, charging at a third
	 * of its rate while the surplus went to the grid.
	 */
	maxCharge: number;
	/**
	 * Inverter output limit in W (device field IS). Also separate from MG: IS covers
	 * what the load port draws as well, so an export cap must not throttle it.
	 */
	maxInverter: number;
	/** Reported load-port power LP in W (0 when nothing is wired to it). */
	lp: number;
	/** Reported PV power in W, used to cap the inverter limit on an empty battery. */
	pv: number;
	/**
	 * Discharge-side SoC hysteresis band in percent (device field SI1, 5% by default).
	 *
	 * The device does not resume at exactly its SoC limit — it waits until the charge
	 * has moved this far back into the usable range. Mirroring that here stops the loop
	 * from commanding power the device will refuse for the whole width of the band.
	 */
	socHysteresisDischarge: number;
	/** Charge-side SoC hysteresis band in percent (device field SA1). */
	socHysteresisCharge: number;
}

/** Resulting grid setpoint for a single head. */
export interface HeadSetpoint {
	/** 1-based head number. */
	index: number;
	/** GS to write to this head in W (+feed-in). */
	gs: number;
	/**
	 * True when this head got nothing because it is at its SoC limit in the requested
	 * direction — as opposed to getting nothing because the total was zero, because it
	 * is offline, or because its share rounded away.
	 *
	 * The caller cannot tell those apart from `gs === 0`, and guessing it wrong feeds
	 * the hysteresis memory with heads that were never saturated.
	 */
	socLimited: boolean;
}

/**
 * Aggregate control law: total grid setpoint from the summed grid power and the
 * measured house grid power. Mirrors the single-head controller at N=1.
 *
 * The two limits are separate and the clamp is asymmetric. Picking one of them by the
 * sign of the *error* is wrong: a positive error only means "raise the setpoint", and
 * while the plant is charging the result usually stays negative and still needs the
 * charge limit. Clamping that to the export sum cut a −2000 W setpoint to −800 W on the
 * first small correction.
 *
 * @param totalGp Sum of the reported GP of all online heads (W, +feed-in).
 * @param gridPower House grid power normalized to ">0 = draw" (import).
 * @param gain Proportional gain.
 * @param sumMaxExport Sum of the online heads' export limits (W), the positive bound.
 * @param sumMaxCharge Sum of the online heads' charge limits (W), the negative bound.
 */
export function computeTotalTarget(
	totalGp: number,
	gridPower: number,
	gain: number,
	sumMaxExport: number,
	sumMaxCharge: number,
): number {
	return clamp(Math.round(totalGp + gain * gridPower), -Math.abs(sumMaxCharge), Math.abs(sumMaxExport));
}

/**
 * Whether a head's charge sits inside the device's discharge hysteresis band.
 *
 * The device stops discharging at `socMin` and does not resume until the charge has
 * risen `SI1` above it. A head in that range is not usable for discharging even
 * though it is above the floor.
 *
 * @param h the head to judge
 */
export function inDischargeBand(h: HeadState): boolean {
	const band = Math.max(0, h.socHysteresisDischarge);
	return band > 0 && h.soc > h.socMin && h.soc <= h.socMin + band;
}

/**
 * Whether a head's charge sits inside the device's charge hysteresis band (`SA1`).
 *
 * @param h the head to judge
 */
export function inChargeBand(h: HeadState): boolean {
	const band = Math.max(0, h.socHysteresisCharge);
	return band > 0 && h.soc < h.socMax && h.soc >= h.socMax - band;
}

/**
 * Split a total grid setpoint equally across the eligible heads, capped per head
 * with overflow redistribution. A head is eligible while it is online and still has
 * SoC headroom in the requested direction; saturated and offline heads receive 0.
 *
 * @param totalTarget Total GS to distribute (W, +discharge / -charge).
 * @param heads Current per-head state.
 * @param resuming Head indexes that were saturated on the previous cycle. They have to
 * clear the device's own SoC hysteresis band before they are used again — without that
 * the loop commands power the device refuses, integrates to the limit, gets corrected
 * by the anti-windup, and starts over, writing continuously for as long as the SoC sits
 * inside the band.
 */
export function splitTarget(
	totalTarget: number,
	heads: HeadState[],
	resuming: ReadonlySet<number> = new Set(),
): HeadSetpoint[] {
	const result = new Map<number, number>(heads.map(h => [h.index, 0]));
	const charging = totalTarget < 0;

	// Eligible: online, has power, and not yet at its SoC limit in this direction.
	const eligible = (h: HeadState): boolean => {
		if (!h.online || !h.controllable || Math.abs(h.maxPower) <= 0) {
			return false;
		}
		// A head that just dropped out has to come back past the hysteresis band — the
		// one for the direction being asked for. The device keeps two (SI1 below, SA1
		// above); collapsing them to one would apply the larger band to both sides and
		// hold a head back from discharging because of a charge-side setting.
		if (resuming.has(h.index) && (charging ? inChargeBand(h) : inDischargeBand(h))) {
			return false;
		}
		return charging ? h.soc < h.socMax : h.soc > h.socMin;
	};
	// Per-head power cap, signed like the target.
	const cap = (h: HeadState): number => (charging ? -Math.abs(h.maxCharge) : Math.abs(h.maxPower));

	let pool = heads.filter(eligible);
	let fixedSum = 0; // sum of the caps of heads already saturated

	// Water-filling with equal shares: distribute (totalTarget - fixedSum) evenly,
	// fix any head that exceeds its cap, repeat with the reduced remainder.
	for (let pass = 0; pass <= heads.length && pool.length > 0; pass++) {
		const share = (totalTarget - fixedSum) / pool.length;
		const newlyFixed: HeadState[] = [];
		for (const h of pool) {
			if (Math.abs(share) >= Math.abs(cap(h))) {
				result.set(h.index, cap(h));
				newlyFixed.push(h);
			} else {
				result.set(h.index, share);
			}
		}
		if (newlyFixed.length === 0) {
			break; // every share is within its cap → done
		}
		for (const h of newlyFixed) {
			fixedSum += cap(h);
		}
		pool = pool.filter(h => !newlyFixed.includes(h));
	}

	return heads.map(h => ({
		index: h.index,
		gs: Math.round(result.get(h.index) ?? 0),
		// Only heads that are online and capable but blocked by SoC count as limited.
		socLimited:
			totalTarget !== 0 &&
			h.online &&
			h.controllable &&
			Math.abs(h.maxPower) > 0 &&
			!(charging ? h.soc < h.socMax : h.soc > h.socMin),
	}));
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

/**
 * Inverter output limit (IS) for one head, given the GS it was just commanded.
 *
 * GS only states what should cross the *grid* port. Whatever a local load draws from
 * the load port comes on top, so the inverter has to be allowed to produce both:
 *
 *   IS = clamp(max(GS, 0) + max(LP, 0), 0, maxPower)
 *
 * On installations with nothing wired to the load port (LP = 0) this reduces to the
 * discharge part of GS, and to 0 while charging — the inverter is not meant to output
 * anything then.
 *
 * Once the head is at its discharge floor the limit is additionally capped to the
 * current PV power: anything above that could only come out of a battery that has
 * already reached its minimum SoC. This mirrors the manufacturer blueprint, which
 * caps IS to PV whenever discharging is blocked by SoC.
 *
 * @param head Current head state.
 * @param gs The GS setpoint just computed for this head (W, +discharge).
 */
export function computeIsTarget(head: HeadState, gs: number): number {
	const loadDemand = Math.max(head.lp, 0);
	let target = Math.max(gs, 0) + loadDemand;
	if (head.soc <= head.socMin) {
		target = Math.min(target, Math.max(head.pv, 0));
	}
	// Lower bound 1, not 0: the device documents IS as 1..2400, and a manual write of 0
	// is refused for that reason. The controller writing it anyway would be the adapter
	// contradicting itself. 1 W is the vendor's own floor and means the same thing.
	return Math.round(clamp(target, 1, Math.abs(head.maxInverter)));
}
