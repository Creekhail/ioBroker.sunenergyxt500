/*
 * Optional self-consumption controller (feed-forward + P correction on GS).
 *
 * Ported from the original SunEnergyXT_regler.js. It reads a configurable foreign
 * grid-power state (e.g. a Shelly meter) and writes the GS setpoint to the device:
 *
 *   GS_new = GP_actual + gain * gridPower
 *
 * where GP_actual is the device's reported grid power (same sign convention as GS,
 * +feed-in). Reading GP back from the device provides natural anti-windup when the
 * device internally limits (e.g. by SoC).
 *
 * Sign convention of the source state: > 0 = grid draw, < 0 = feed-in (Shelly).
 * If the configured meter uses the opposite convention, enable `inverted`.
 *
 * Watchdog: if the source state goes stale (sensor/network dead) GS would otherwise
 * freeze at its last value. Two stages:
 *   - from warnSec:     log + telemetry only
 *   - from failsafeSec: GS = 0 (safe neutral) until the source recovers
 */

import type { SunEnergyXtApi } from './api';
import type { LocalizedName } from './states';

export interface ControllerConfig {
	gain: number;
	deadBandW: number;
	minIntervalMs: number;
	maxPowerW: number;
	inverted: boolean;
	warnSec: number;
	failsafeSec: number;
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

export class Controller {
	private lastWriteTime = 0;
	private lastGS: number | null = null;
	private writeInProgress = false;
	private everSeenSource = false;
	private failsafeActive = false;
	private warnLogged = false;
	private maxGapSec = 0;
	private watchdogTimer?: ioBroker.Interval;

	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly api: SunEnergyXtApi,
		private readonly gridStateId: string,
		private readonly cfg: ControllerConfig,
	) {}

	/** Sets GS to a neutral 0 and starts the watchdog. */
	public async start(): Promise<void> {
		try {
			await this.api.write({ GS: 0 });
			this.lastGS = 0;
			this.lastWriteTime = Date.now();
			await this.setGridSetpointState(0);
			await this.adapter.setStateChangedAsync('controller.status', 'ok', true);
			this.adapter.log.info('Controller started — GS set to 0.');
		} catch (e) {
			this.adapter.log.warn(`Controller start error: ${errMsg(e)}`);
		}
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
	 * @param value
	 */
	public async onGridPower(value: number): Promise<void> {
		if (!Number.isFinite(value)) {
			return;
		}
		// Every source event proves the sensor is alive → reset watchdog / recover
		this.everSeenSource = true;
		if (this.failsafeActive) {
			this.adapter.log.info('Grid source back — controller active again.');
		}
		if (this.failsafeActive || this.warnLogged) {
			this.failsafeActive = false;
			this.warnLogged = false;
			await this.adapter.setStateChangedAsync('controller.status', 'ok', true);
		}
		await this.writeGS(this.normalize(value));
	}

	/**
	 * Normalize the source value to the convention "> 0 = grid draw".
	 *
	 * @param value
	 */
	private normalize(value: number): number {
		return this.cfg.inverted ? -value : value;
	}

	private async writeGS(gridPower: number): Promise<void> {
		if (this.writeInProgress) {
			return;
		}
		const now = Date.now();
		if (now - this.lastWriteTime < this.cfg.minIntervalMs) {
			return;
		}
		if (this.lastGS !== null && Math.abs(gridPower) < this.cfg.deadBandW) {
			return;
		}

		this.writeInProgress = true;
		try {
			// Read actual grid power from the device (GP: +feed-in, same sign as GS)
			const { reported } = await this.api.read();
			const gp = Number(reported.GP);
			if (!Number.isFinite(gp)) {
				this.adapter.log.warn('Controller: invalid GP — no write.');
				return;
			}
			const delta = Math.round(this.cfg.gain * gridPower);
			const gs = clamp(gp + delta, -this.cfg.maxPowerW, this.cfg.maxPowerW);
			if (gs === this.lastGS) {
				return;
			}
			await this.api.write({ GS: gs });
			this.lastGS = gs;
			this.lastWriteTime = now;
			await this.setGridSetpointState(gs);
			this.adapter.log.debug(`GP=${Math.round(gp)} + Δ=${delta} → GS=${gs} (source=${Math.round(gridPower)} W)`);
		} catch (e) {
			this.adapter.log.warn(`Controller error: ${errMsg(e)}`);
		} finally {
			this.writeInProgress = false;
		}
	}

	private async writeFailsafeGS(): Promise<void> {
		if (this.writeInProgress || this.lastGS === 0) {
			return;
		}
		this.writeInProgress = true;
		try {
			await this.api.write({ GS: 0 });
			this.lastGS = 0;
			this.lastWriteTime = Date.now();
			await this.setGridSetpointState(0);
			this.adapter.log.warn('FAILSAFE — grid source stale → GS set to 0.');
		} catch (e) {
			this.adapter.log.warn(`Controller failsafe write error: ${errMsg(e)}`);
		} finally {
			this.writeInProgress = false;
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
				this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s → failsafe.`);
			}
			await this.writeFailsafeGS();
		} else if (ageSec >= this.cfg.warnSec) {
			if (!this.warnLogged) {
				this.warnLogged = true;
				await this.adapter.setStateChangedAsync('controller.status', 'warn', true);
				this.adapter.log.info(`Warn: grid source without update for ${Math.round(ageSec)} s.`);
			}
		}
	}

	private async setGridSetpointState(gs: number): Promise<void> {
		await this.adapter.setStateChangedAsync('control.GS', gs, true);
	}
}

function clamp(v: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, v));
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
