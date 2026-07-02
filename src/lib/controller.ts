/*
 * Multi-head self-consumption controller.
 *
 * One control loop reads a configurable foreign grid-power state (e.g. a Shelly
 * meter) and steers up to three heads at once:
 *
 *   totalTarget = clamp(ΣGP + gain * gridPower, -Σmax, +Σmax)
 *   GS_i        = splitTarget(totalTarget, heads)   // equal split, headroom-gated
 *
 * Per-head SoC/limits come from the regular poll snapshot, and the feed-forward base
 * is the last commanded GS (both avoid extra device reads; the last GS tracks each
 * head's actual grid power because the device executes it).
 * Each head is only re-written when its setpoint moved by more than a dead band, to
 * avoid chatter as the split shifts. At N=1 this reduces to the original single-head
 * feed-forward + P behaviour.
 *
 * Sign convention of the source state: > 0 = grid draw, < 0 = feed-in (Shelly).
 * If the configured meter uses the opposite convention, enable `inverted`.
 *
 * Watchdog: if the source state goes stale (sensor/network dead) the setpoints would
 * otherwise freeze. Two stages:
 *   - from warnSec:     log + telemetry only
 *   - from failsafeSec: GS = 0 on every head (safe neutral) until the source recovers
 */

import type { HeadState } from './split';
import { computeTotalTarget, splitTarget } from './split';
import type { LocalizedName } from './states';

export interface ControllerConfig {
	gain: number;
	deadBandW: number;
	minIntervalMs: number;
	/** Minimum change of a head's setpoint before it is re-written (anti-chatter). */
	writeDeadBandW: number;
	inverted: boolean;
	warnSec: number;
	failsafeSec: number;
}

/** I/O the controller needs from the adapter (kept abstract for testability). */
export interface ControllerHooks {
	/** Current per-head snapshot (online flag + fields) used for the split. */
	getHeads(): HeadState[];
	/** Writes a GS setpoint (W, +feed-in) to the head with the given 1-based index. */
	writeGs(index: number, gs: number): Promise<void>;
	/** Mirrors the commanded GS onto heads.<index>.control.GS. */
	reflectGs(index: number, gs: number): Promise<void>;
}

/** Objects created for controller telemetry. */
export const controllerStateDefs: {
	id: string;
	type: ioBroker.CommonType;
	role: string;
	unit?: string;
	name: LocalizedName;
}[] = [
	{
		id: 'controller.status',
		type: 'string',
		role: 'text',
		name: { en: 'Controller watchdog status (ok/warn/failsafe)', de: 'Regler-Watchdog-Status (ok/warn/failsafe)' },
	},
	{
		id: 'controller.gridSourceAge',
		type: 'number',
		role: 'value',
		unit: 's',
		name: { en: 'Age of last grid-source value', de: 'Alter des letzten Netzquelle-Werts' },
	},
	{
		id: 'controller.maxGridSourceAge',
		type: 'number',
		role: 'value',
		unit: 's',
		name: { en: 'Largest observed grid-source gap', de: 'Größte beobachtete Netzquelle-Lücke' },
	},
];

const WATCHDOG_INTERVAL_MS = 15000;

/**
 * Anti-windup sync: when a head's polled grid power deviates this much from the
 * commanded GS although the last write is old enough, the device is internally
 * limiting (SoC/temperature) — adopt the reported value as the new base.
 */
const SYNC_DEVIATION_W = 150;
const SYNC_MIN_AGE_MS = 10000;

export class MultiHeadController {
	private lastWriteTime = 0;
	private readonly lastGs = new Map<number, number>();
	private writeInProgress = false;
	private everSeenSource = false;
	private failsafeActive = false;
	private warnLogged = false;
	private maxGapSec = 0;
	private watchdogTimer?: ioBroker.Interval;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly hooks: ControllerHooks,
		private readonly gridStateId: string,
		private readonly cfg: ControllerConfig,
	) {}

	/** Sets every head to a neutral GS=0 and starts the watchdog. */
	public async start(): Promise<void> {
		await this.writeAll(0);
		await this.adapter.setStateChangedAsync('controller.status', 'ok', true);
		this.adapter.log.info('Multi-head controller started — all heads GS=0.');
		this.watchdogTimer = this.adapter.setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
	}

	public stop(): void {
		if (this.watchdogTimer) {
			this.adapter.clearInterval(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
	}

	/**
	 * Handle a new value of the configured grid-power source state.
	 *
	 * @param value raw source value
	 */
	public async onGridPower(value: number): Promise<void> {
		if (!Number.isFinite(value)) {
			return;
		}
		this.everSeenSource = true;
		if (this.failsafeActive || this.warnLogged) {
			if (this.failsafeActive) {
				this.adapter.log.info('Grid source back — controller active again.');
			}
			this.failsafeActive = false;
			this.warnLogged = false;
			await this.adapter.setStateChangedAsync('controller.status', 'ok', true);
		}
		await this.regulate(this.cfg.inverted ? -value : value);
	}

	/**
	 * Computes the total setpoint, splits it and writes the per-head GS.
	 *
	 * @param gridPower normalized grid power (> 0 = draw)
	 */
	private async regulate(gridPower: number): Promise<void> {
		if (this.writeInProgress) {
			return;
		}
		const now = Date.now();
		if (now - this.lastWriteTime < this.cfg.minIntervalMs) {
			return;
		}
		if (Math.abs(gridPower) < this.cfg.deadBandW) {
			return; // grid close enough to zero — nothing to correct
		}
		const heads = this.hooks.getHeads().filter(h => h.online);
		if (!heads.length) {
			return;
		}
		// Feed-forward base: the GS we last commanded each head. Because every head
		// executes its GS (its grid power tracks GS), this equals the current grid
		// power without an extra read — and unlike a stale poll snapshot it lets the
		// loop integrate to zero grid power instead of leaving a steady-state error.
		const base = heads.reduce(
			(acc, h) => acc + (this.lastGs.get(h.index) ?? (Number.isFinite(h.gp) ? h.gp : 0)),
			0,
		);
		const sumMax = heads.reduce((acc, h) => acc + Math.abs(h.maxPower), 0);
		const totalTarget = computeTotalTarget(base, gridPower, this.cfg.gain, sumMax);
		const setpoints = splitTarget(totalTarget, heads);

		this.writeInProgress = true;
		try {
			let wroteAny = false;
			for (const sp of setpoints) {
				const prev = this.lastGs.get(sp.index);
				if (prev !== undefined && Math.abs(sp.gs - prev) < this.cfg.writeDeadBandW) {
					continue;
				}
				// Isolate each head: a failing write must not abort the other heads.
				try {
					await this.hooks.writeGs(sp.index, sp.gs);
					await this.hooks.reflectGs(sp.index, sp.gs);
					this.lastGs.set(sp.index, sp.gs);
					wroteAny = true;
				} catch (e) {
					this.adapter.log.warn(`Head ${sp.index}: GS write failed: ${errMsg(e)}`);
				}
			}
			if (wroteAny) {
				this.lastWriteTime = now;
				this.adapter.log.debug(
					`Total target ${totalTarget} W → ${setpoints.map(s => `H${s.index}:${s.gs}`).join(' ')} (grid ${Math.round(gridPower)} W)`,
				);
			}
		} finally {
			this.writeInProgress = false;
		}
	}

	/**
	 * Anti-windup feedback from the regular poll: if the device visibly does not
	 * follow the commanded GS (internal limiting by SoC/temperature), adopt its
	 * reported grid power as the new feed-forward base so the loop keeps converging.
	 *
	 * @param index 1-based head number
	 * @param gp the head's polled grid-port power (W, +feed-in)
	 */
	public noteReportedGp(index: number, gp: number): void {
		if (!Number.isFinite(gp)) {
			return;
		}
		const last = this.lastGs.get(index);
		if (last === undefined || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
			return;
		}
		if (Math.abs(gp - last) > SYNC_DEVIATION_W) {
			this.lastGs.set(index, Math.round(gp));
			this.adapter.log.debug(
				`Head ${index}: device delivers ${Math.round(gp)} W instead of commanded ${last} W — adopting as feed-forward base (anti-windup).`,
			);
		}
	}

	/**
	 * Drops the remembered setpoint of a head (e.g. it went offline and may reboot
	 * with GS=0), so the base falls back to its polled grid power on return.
	 *
	 * @param index 1-based head number
	 */
	public forgetHead(index: number): void {
		this.lastGs.delete(index);
	}

	/**
	 * Writes the same GS to every head (used for start and failsafe).
	 *
	 * @param gs setpoint to write
	 * @param onlineOnly restrict to online heads and skip heads already at gs
	 * (used by the repeating failsafe tick to avoid retry/log spam on offline heads)
	 */
	private async writeAll(gs: number, onlineOnly = false): Promise<void> {
		for (const h of this.hooks.getHeads()) {
			if (onlineOnly && (!h.online || this.lastGs.get(h.index) === gs)) {
				continue;
			}
			try {
				await this.hooks.writeGs(h.index, gs);
				await this.hooks.reflectGs(h.index, gs);
				this.lastGs.set(h.index, gs);
			} catch (e) {
				this.adapter.log.warn(`Head ${h.index}: GS write failed: ${errMsg(e)}`);
			}
		}
	}

	private async watchdogTick(): Promise<void> {
		if (!this.everSeenSource) {
			return;
		}
		let ageSec = Infinity;
		try {
			const st = await this.adapter.getForeignStateAsync(this.gridStateId);
			if (st && st.ts) {
				ageSec = (Date.now() - st.ts) / 1000;
			}
		} catch {
			/* treat as stale */
		}

		await this.adapter.setStateChangedAsync(
			'controller.gridSourceAge',
			Math.round(Number.isFinite(ageSec) ? ageSec : 0),
			true,
		);
		if (Number.isFinite(ageSec) && ageSec > this.maxGapSec) {
			this.maxGapSec = ageSec;
			await this.adapter.setStateChangedAsync('controller.maxGridSourceAge', Math.round(this.maxGapSec), true);
		}

		if (ageSec >= this.cfg.failsafeSec) {
			if (!this.failsafeActive) {
				this.failsafeActive = true;
				await this.adapter.setStateChangedAsync('controller.status', 'failsafe', true);
				this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s → failsafe (all heads GS=0).`);
			}
			if (!this.writeInProgress) {
				this.writeInProgress = true;
				try {
					await this.writeAll(0, true);
				} finally {
					this.writeInProgress = false;
				}
			}
		} else if (ageSec >= this.cfg.warnSec) {
			if (!this.warnLogged) {
				this.warnLogged = true;
				await this.adapter.setStateChangedAsync('controller.status', 'warn', true);
				this.adapter.log.info(`Warn: grid source without update for ${Math.round(ageSec)} s.`);
			}
		}
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
