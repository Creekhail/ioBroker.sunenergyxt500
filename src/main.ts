/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for SunEnergyXT 500 / 500 PRO battery storage systems.
 * Polls the local HTTP API (/read), mirrors all fields to states, lets the user
 * write control fields back (/write), and optionally runs a self-consumption
 * controller on the grid setpoint (GS).
 */

import * as utils from '@iobroker/adapter-core';
import type { ReportedState } from './lib/api';
import { SunEnergyXtApi } from './lib/api';
import type { ControllerConfig } from './lib/controller';
import { Controller, controllerStateDefs } from './lib/controller';
import type { StateDef } from './lib/states';
import { applyMeterModeCoupling, buildMeterMd, controlDefs, measurementDefs, roundTo } from './lib/states';

/** Delay before re-reading the device to confirm a control write. */
const WRITE_CONFIRM_DELAY_MS = 1500;

class Sunenergyxt500 extends utils.Adapter {
	private api!: SunEnergyXtApi;
	private controller?: Controller;
	private gridStateId = '';
	private pollIntervalMs = 5000;
	private isConnected = false;
	/** Active control mode: off (monitoring), controller (Mode B) or device (Mode A). */
	private controlMode: 'off' | 'controller' | 'device' = 'off';
	/** Built meter-connection string (MD) for device mode; '' when unconfigured. */
	private meterMd = '';
	/** Whether the MM-mismatch warning was already logged (reset once consistent). */
	private mmGuardWarned = false;
	private pollTimer?: ioBroker.Timeout;
	/** relative control state id → its definition */
	private readonly controlMap = new Map<string, StateDef>();

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'sunenergyxt500',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setState('info.connection', false, true);

		const host = (this.config.host || '').trim();
		if (!host) {
			this.log.error('No device host/IP configured. Please set it in the adapter settings.');
			return;
		}

		this.pollIntervalMs = Math.max(1000, Math.round((Number(this.config.pollInterval) || 5) * 1000));
		const timeoutMs = Math.max(1000, Math.round(Number(this.config.requestTimeout) || 8000));
		this.api = new SunEnergyXtApi(host, timeoutMs);
		this.controlMode = this.config.controlMode || 'off';

		for (const def of controlDefs) {
			this.controlMap.set(def.id, def);
		}

		await this.createObjects();

		this.subscribeStates('control.*');

		if (this.controlMode === 'device') {
			this.meterMd = buildMeterMd({
				type: this.config.meterType,
				id: this.config.meterId,
				tasmotaSubtype: this.config.meterTasmotaSubtype,
			});
			if (!this.meterMd) {
				this.log.warn(
					'Device self-regulation selected, but the meter is not configured correctly — no meter is bound.',
				);
			}
		}

		// Bring the device into the state required by the chosen control mode before polling.
		await this.enforceMode('startup');

		if (this.controlMode === 'controller') {
			await this.setupController();
		}

		this.log.info(`Control mode: ${this.controlMode}. Polling ${host} every ${this.pollIntervalMs / 1000}s.`);
		void this.pollLoop();
	}

	private async setupController(): Promise<void> {
		this.gridStateId = (this.config.gridPowerStateId || '').trim();
		if (!this.gridStateId) {
			this.log.warn('Controller enabled but no grid-power source state configured — controller not started.');
			return;
		}
		const cfg: ControllerConfig = {
			gain: Number(this.config.controllerGain) || 0.3,
			deadBandW: Number(this.config.controllerDeadBandW) || 20,
			minIntervalMs: Math.max(1000, Number(this.config.controllerMinIntervalMs) || 5000),
			maxPowerW: Number(this.config.controllerMaxPowerW) || 2400,
			inverted: !!this.config.gridPowerInverted,
			warnSec: Number(this.config.watchdogWarnSec) || 30,
			failsafeSec: Number(this.config.watchdogFailsafeSec) || 180,
		};
		this.controller = new Controller(this, this.api, this.gridStateId, cfg);
		await this.subscribeForeignStatesAsync(this.gridStateId);
		await this.controller.start();
		this.log.info(`Self-consumption controller active on grid source "${this.gridStateId}".`);
	}

	/**
	 * Writes the device fields (MM/MD) required by the active control mode, so a
	 * leftover or externally-set mode cannot lame the chosen control path:
	 * controller mode needs MM=0 (device executes GS), device mode needs
	 * MM=1 + the bound meter (MD). In "off" mode the device is left untouched.
	 *
	 * @param reason - context shown in the log line
	 */
	private async enforceMode(reason: string): Promise<void> {
		let payload: Record<string, string | number> | null = null;
		if (this.controlMode === 'controller') {
			payload = { MM: 0, MD: '' };
		} else if (this.controlMode === 'device') {
			if (!this.meterMd) {
				return; // misconfigured — already warned, leave the device alone
			}
			payload = { MM: 1, MD: this.meterMd };
		}
		if (!payload) {
			return; // off — pure monitoring
		}
		try {
			await this.api.write(payload);
			this.log.info(`Enforced ${this.controlMode} mode (${reason}): ${JSON.stringify(payload)}.`);
		} catch (e) {
			this.log.warn(`Could not enforce ${this.controlMode} mode: ${errMsg(e)}`);
		}
	}

	/**
	 * Keeps the device's self-consumption mode (MM) consistent with the chosen
	 * control mode on every poll. An external MM change (e.g. by another script
	 * or the manufacturer app) would otherwise silently break control:
	 * Mode B needs MM=0, Mode A needs MM=1. On mismatch we re-assert and warn once.
	 *
	 * @param data - the latest reported device state
	 */
	private async guardMeterMode(data: ReportedState): Promise<void> {
		if (this.controlMode === 'off') {
			return;
		}
		if (this.controlMode === 'device' && !this.meterMd) {
			return; // unconfigured device mode — nothing to enforce
		}
		const want = this.controlMode === 'controller' ? 0 : 1;
		const mm = Number(data.MM);
		if (!Number.isFinite(mm) || mm === want) {
			this.mmGuardWarned = false;
			return;
		}
		if (!this.mmGuardWarned) {
			this.mmGuardWarned = true;
			this.log.warn(
				`Device MM=${mm} does not match ${this.controlMode} mode (expected ${want}) — re-asserting. Another script or the app may be changing MM.`,
			);
		}
		await this.enforceMode('guard');
	}

	/** Creates channel and state objects for all measurement, control and controller states. */
	private async createObjects(): Promise<void> {
		const ids = [
			...measurementDefs.map(d => d.id),
			...controlDefs.map(d => d.id),
			...controllerStateDefs.map(d => d.id),
			'info.lastUpdate',
			'info.lastError',
		];
		await this.ensureChannels(ids);

		for (const def of [...measurementDefs, ...controlDefs]) {
			await this.setObjectNotExistsAsync(def.id, {
				type: 'state',
				common: {
					name: def.name,
					type: def.type,
					role: def.role,
					unit: def.unit,
					read: true,
					write: !!def.write,
					states: def.states,
					def: def.type === 'string' ? '' : def.type === 'boolean' ? false : 0,
				},
				native: {},
			});
		}
		for (const def of controllerStateDefs) {
			await this.setObjectNotExistsAsync(def.id, {
				type: 'state',
				common: {
					name: def.name,
					type: def.type,
					role: def.role,
					unit: def.unit,
					read: true,
					write: false,
					def: def.type === 'string' ? '' : 0,
				},
				native: {},
			});
		}
		await this.setObjectNotExistsAsync('info.lastUpdate', {
			type: 'state',
			common: {
				name: { en: 'Last successful poll', de: 'Letzte erfolgreiche Abfrage' },
				type: 'string',
				role: 'date',
				read: true,
				write: false,
				def: '',
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('info.lastError', {
			type: 'state',
			common: {
				name: { en: 'Last error', de: 'Letzter Fehler' },
				type: 'string',
				role: 'text',
				read: true,
				write: false,
				def: '',
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('info.rawResponse', {
			type: 'state',
			common: {
				name: { en: 'Raw /read response (JSON)', de: 'Rohantwort /read (JSON)' },
				type: 'string',
				role: 'json',
				read: true,
				write: false,
				def: '',
			},
			native: {},
		});
	}

	/**
	 * Ensures a channel object exists for every parent path of the given state ids.
	 *
	 * @param ids
	 */
	private async ensureChannels(ids: string[]): Promise<void> {
		const parents = new Set<string>();
		for (const id of ids) {
			const parts = id.split('.');
			for (let i = 1; i < parts.length; i++) {
				parents.add(parts.slice(0, i).join('.'));
			}
		}
		for (const p of [...parents].sort()) {
			await this.setObjectNotExistsAsync(p, {
				type: 'channel',
				common: { name: p.split('.').pop() || p },
				native: {},
			});
		}
	}

	private async pollLoop(): Promise<void> {
		await this.readAndApply();
		this.pollTimer = this.setTimeout(() => void this.pollLoop(), this.pollIntervalMs);
	}

	/** Reads the device once and writes all states (without rescheduling). */
	private async readAndApply(): Promise<void> {
		try {
			const { reported: data, body } = await this.api.read();
			for (const def of [...measurementDefs, ...controlDefs]) {
				if (!def.derive && !(def.field in data)) {
					continue;
				}
				const raw = def.derive ? def.derive(data) : data[def.field];
				if (def.type === 'string') {
					await this.setStateChangedAsync(def.id, asString(raw), true);
				} else if (def.type === 'number') {
					const n = roundTo(raw, def.decimals ?? 0, def.scale ?? 1);
					if (n !== null) {
						await this.setStateChangedAsync(def.id, n, true);
					}
				}
				// boolean control fields (RT) are write-only and not read back
			}
			// Keep the device's self-consumption mode (MM) consistent with the control mode.
			await this.guardMeterMode(data);
			// Keep the complete original /read response available so power users can read
			// any unmapped field themselves, without polluting the tree with cryptic states.
			await this.setStateChangedAsync('info.rawResponse', body, true);
			if (!this.isConnected) {
				this.isConnected = true;
				await this.setState('info.connection', true, true);
			}
			await this.setStateChangedAsync('info.lastUpdate', new Date().toISOString(), true);
			await this.setStateChangedAsync('info.lastError', '', true);
		} catch (e) {
			if (this.isConnected) {
				this.isConnected = false;
				await this.setState('info.connection', false, true);
			}
			await this.setStateChangedAsync('info.lastError', errMsg(e), true);
			this.log.warn(`Poll failed: ${errMsg(e)}`);
		}
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			return;
		}
		// Foreign grid-power source: react to every update (Shelly writes with ack=true)
		if (this.controller && id === this.gridStateId) {
			void this.controller.onGridPower(Number(state.val));
			return;
		}
		// Own control states: only act on user commands (ack=false)
		if (state.ack) {
			return;
		}
		const rel = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
		void this.handleControlWrite(rel, state);
	}

	/**
	 * Sends a writable control field to the device and confirms via a re-read.
	 *
	 * @param relId
	 * @param state
	 */
	private async handleControlWrite(relId: string, state: ioBroker.State): Promise<void> {
		const def = this.controlMap.get(relId);
		if (!def) {
			return;
		}
		let payload: Record<string, string | number>;
		if (def.field === 'RT') {
			if (!state.val) {
				return;
			}
			payload = { RT: 1 };
		} else if (def.type === 'string') {
			payload = { [def.field]: state.val == null ? '' : String(state.val) };
		} else {
			const n = roundTo(state.val, 0);
			if (n === null) {
				this.log.warn(`Ignoring invalid value for ${def.id}: ${state.val}`);
				return;
			}
			payload = { [def.field]: n };
		}

		// MM/MD coupling, matching the official integration.
		applyMeterModeCoupling(def.field, payload);

		try {
			await this.api.write(payload);
			this.log.info(`Wrote ${JSON.stringify(payload)} to device.`);
			if (def.field !== 'RT') {
				// Confirm the effect by re-reading (device echoes most fields)
				this.setTimeout(() => void this.readAndApply(), WRITE_CONFIRM_DELAY_MS);
			}
		} catch (e) {
			this.log.warn(`Write ${def.field} failed: ${errMsg(e)}`);
		}
	}

	private onUnload(callback: () => void): void {
		try {
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
			}
			this.controller?.stop();
			callback();
		} catch {
			callback();
		}
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Safely converts an unknown API value to a string (objects become JSON).
 *
 * @param value
 */
function asString(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return JSON.stringify(value);
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Sunenergyxt500(options);
} else {
	// otherwise start the instance directly
	(() => new Sunenergyxt500())();
}
