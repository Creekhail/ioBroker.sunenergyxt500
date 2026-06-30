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
	/** false if the head is unreachable/faulted — it is excluded from the split. */
	online: boolean;
	/** Reported grid-port power GP in W (+feed-in), used for the aggregate loop. */
	gp: number;
	/** Master state of charge in percent (0..100). */
	soc: number;
	/** Minimum discharge SoC limit in percent (SI/SO). */
	socMin: number;
	/** Maximum charge SoC limit in percent (SA). */
	socMax: number;
	/** Maximum charge/discharge power in W (e.g. 800 for 500, 2400 for 500 PRO). */
	maxPower: number;
}

/** Resulting grid setpoint for a single head. */
export interface HeadSetpoint {
	/** 1-based head number. */
	index: number;
	/** GS to write to this head in W (+feed-in). */
	gs: number;
}

/**
 * Aggregate control law: total grid setpoint from the summed grid power and the
 * measured house grid power. Mirrors the single-head controller at N=1.
 *
 * @param totalGp Sum of the reported GP of all online heads (W, +feed-in).
 * @param gridPower House grid power normalized to ">0 = draw" (import).
 * @param gain Proportional gain.
 * @param sumMaxPower Sum of the online heads' maxPower (W).
 */
export function computeTotalTarget(totalGp: number, gridPower: number, gain: number, sumMaxPower: number): number {
	const limit = Math.abs(sumMaxPower);
	return clamp(Math.round(totalGp + gain * gridPower), -limit, limit);
}

/**
 * Split a total grid setpoint equally across the eligible heads, capped per head
 * with overflow redistribution. A head is eligible while it is online and still has
 * SoC headroom in the requested direction; saturated and offline heads receive 0.
 *
 * @param totalTarget Total GS to distribute (W, +discharge / -charge).
 * @param heads Current per-head state.
 */
export function splitTarget(totalTarget: number, heads: HeadState[]): HeadSetpoint[] {
	const result = new Map<number, number>(heads.map(h => [h.index, 0]));
	const charging = totalTarget < 0;

	// Eligible: online, has power, and not yet at its SoC limit in this direction.
	const eligible = (h: HeadState): boolean => {
		if (!h.online || Math.abs(h.maxPower) <= 0) {
			return false;
		}
		return charging ? h.soc < h.socMax : h.soc > h.socMin;
	};
	// Per-head power cap, signed like the target.
	const cap = (h: HeadState): number => (charging ? -Math.abs(h.maxPower) : Math.abs(h.maxPower));

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

	return heads.map(h => ({ index: h.index, gs: Math.round(result.get(h.index) ?? 0) }));
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}
