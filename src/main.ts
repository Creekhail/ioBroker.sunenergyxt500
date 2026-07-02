/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for SunEnergyXT 500 / 500 PRO battery storage systems.
 * Manages up to three heads in a single instance: polls each head's local HTTP
 * API (/read), mirrors all fields to per-head states (heads.<n>.*), aggregates a
 * combined view (total.*) and lets the user write control fields back (/write).
 * In controller mode it runs one self-consumption loop that splits the grid
 * setpoint across all heads; in device mode (single head) it binds a meter and
 * lets the storage regulate itself.
 */

import * as utils from '@iobroker/adapter-core';
import type { ReportedState } from './lib/api';
import { SunEnergyXtApi } from './lib/api';
import type { ControllerConfig, ControllerHooks } from './lib/controller';
import { controllerStateDefs, MultiHeadController } from './lib/controller';
import type { HeadState } from './lib/split';
import type { LocalizedName, StateDef } from './lib/states';
import { applyMeterModeCoupling, buildMeterMd, cfgNum, controlDefs, measurementDefs, roundTo } from './lib/states';

/** Delay before re-reading the device to confirm a control write. */
const WRITE_CONFIRM_DELAY_MS = 1500;

/** Maximum number of heads a single instance manages. */
const MAX_HEADS = 3;

/** All device-field definitions (measurements + controls), precomputed once. */
const ALL_DEFS = [...measurementDefs, ...controlDefs];

/**
 * Top-level ids this adapter manages. The startup cleanup only ever deletes below
 * these roots, so states a user created manually in the namespace survive.
 * Includes the pre-0.2.0 flat roots so upgrades still get cleaned up.
 */
const MANAGED_ROOTS = new Set([
	'heads',
	'total',
	'controller',
	'info',
	// legacy 0.1.x flat tree
	'battery',
	'grid',
	'load',
	'pv',
	'system',
	'device',
	'meter',
	'ups',
	'fault',
	'control',
]);

/** Time budget for writing a neutral GS=0 to the heads during unload. */
const UNLOAD_NEUTRALIZE_BUDGET_MS = 2000;

/** Aggregate (combined) states summarising all heads. */
const AGGREGATE_DEFS: { id: string; role: string; unit?: string; name: LocalizedName }[] = [
	{
		id: 'total.soc',
		role: 'value.battery',
		unit: '%',
		name: { en: 'Total state of charge (capacity-weighted)', de: 'Gesamt-Ladezustand (kapazitätsgewichtet)' },
	},
	{
		id: 'total.batteryPower',
		role: 'value.power',
		unit: 'W',
		name: { en: 'Total battery power (+charge / −discharge)', de: 'Gesamt-Batterieleistung (+laden / −entladen)' },
	},
	{
		id: 'total.gridPower',
		role: 'value.power',
		unit: 'W',
		name: { en: 'Total grid-port power (+feed-in)', de: 'Gesamt-Netzleistung (+Einspeisung)' },
	},
	{
		id: 'total.maxPower',
		role: 'value.power',
		unit: 'W',
		name: { en: 'Total available power (online heads)', de: 'Gesamt verfügbare Leistung (Online-Köpfe)' },
	},
	{
		id: 'total.onlineCount',
		role: 'value',
		name: { en: 'Online heads', de: 'Online-Köpfe' },
	},
];

/** Runtime state of one managed head. */
interface HeadRuntime {
	index: number;
	host: string;
	label: string;
	api: SunEnergyXtApi;
	online: boolean;
	/** Latest snapshot used for the aggregates and (later) the controller split. */
	soc?: number;
	bp?: number;
	gp?: number;
	packs: number;
	maxPower: number;
	socMin?: number;
	socMax?: number;
}

class Sunenergyxt500 extends utils.Adapter {
	private heads: HeadRuntime[] = [];
	private pollIntervalMs = 5000;
	/** Active control mode: off (monitoring), controller (Mode B) or device (Mode A, single head). */
	private controlMode: 'off' | 'controller' | 'device' = 'off';
	/** Built meter-connection string (MD) for device mode; '' when unconfigured. */
	private meterMd = '';
	/** Per-head flag whether the MM-mismatch warning was already logged. */
	private readonly mmGuardWarned = new Map<number, boolean>();
	private pollTimer?: ioBroker.Timeout;
	/** Active multi-head controller (controller mode only). */
	private controller?: MultiHeadController;
	/** Foreign grid-power source state id the controller subscribes to. */
	private gridStateId = '';
	/** relative control state id (e.g. "control.GS") → its definition */
	private readonly controlMap = new Map<string, StateDef>();
	/** Last value confirmed (ack=true) per control state — avoids a DB read per field and poll. */
	private readonly confirmedCache = new Map<string, string | number>();

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'sunenergyxt500',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setStateChangedAsync('info.connection', false, true);

		const timeoutMs = Math.max(1000, Math.round(cfgNum(this.config.requestTimeout, 8000)));
		this.pollIntervalMs = Math.max(1000, Math.round(cfgNum(this.config.pollInterval, 5) * 1000));

		const configured = [
			{ host: this.config.head1Host, label: this.config.head1Label },
			{ host: this.config.head2Host, label: this.config.head2Label },
			{ host: this.config.head3Host, label: this.config.head3Label },
		];
		const seen = new Set<string>();
		this.heads = [];
		for (const c of configured) {
			const host = (c.host || '').trim();
			if (!host) {
				continue;
			}
			const key = host.toLowerCase();
			if (seen.has(key)) {
				this.log.warn(`Ignoring duplicate head host "${host}".`);
				continue;
			}
			seen.add(key);
			if (this.heads.length >= MAX_HEADS) {
				break;
			}
			this.heads.push({
				index: this.heads.length + 1,
				host,
				label: (c.label || '').trim(),
				api: new SunEnergyXtApi(host, timeoutMs),
				online: false,
				packs: 1,
				maxPower: 2400,
			});
		}

		if (!this.heads.length) {
			this.log.error(
				'No storage head configured. Please add at least one head (host/IP) in the adapter settings.',
			);
			return;
		}

		this.controlMode = this.config.controlMode || 'off';
		if (this.controlMode === 'device' && this.heads.length > 1) {
			this.log.error(
				`Device self-regulation is only available with a single head, but ${this.heads.length} are configured — falling back to monitoring (off). Use the adapter controller for multiple heads.`,
			);
			this.controlMode = 'off';
		}

		for (const def of controlDefs) {
			this.controlMap.set(def.id, def);
		}

		await this.createObjects();
		this.subscribeStates('heads.*.control.*');

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

		// Bring every head into the state required by the chosen control mode before polling.
		await this.enforceMode('startup');

		if (this.controlMode === 'controller') {
			await this.setupController();
		}

		this.log.info(
			`Control mode: ${this.controlMode}. Polling ${this.heads.length} head(s) every ${this.pollIntervalMs / 1000}s.`,
		);
		void this.pollLoop();
	}

	/**
	 * Creates all per-head, aggregate, controller and info objects for the current
	 * configuration, then removes any object in this namespace that is no longer part
	 * of the desired set (renamed/removed fields, restructures, fewer heads).
	 */
	private async createObjects(): Promise<void> {
		const desired = new Set<string>();
		const defaultFor = (t: ioBroker.CommonType): string | number | boolean =>
			t === 'string' ? '' : t === 'boolean' ? false : 0;
		const ensure = async (id: string, common: ioBroker.StateCommon): Promise<void> => {
			desired.add(id);
			await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
		};

		for (const h of this.heads) {
			const base = `heads.${h.index}`;
			const name = h.label || `Head ${h.index}`;
			desired.add(base);
			await this.setObjectNotExistsAsync(base, { type: 'device', common: { name }, native: {} });
			await this.extendObjectAsync(base, { common: { name } });

			for (const def of ALL_DEFS) {
				await ensure(`${base}.${def.id}`, {
					name: def.name,
					type: def.type,
					role: def.role,
					unit: def.unit,
					read: true,
					write: !!def.write,
					states: def.states,
					def: defaultFor(def.type),
				});
			}
			await ensure(`${base}.info.online`, {
				name: { en: 'Head reachable', de: 'Kopf erreichbar' },
				type: 'boolean',
				role: 'indicator.reachable',
				read: true,
				write: false,
				def: false,
			});
			await ensure(`${base}.info.lastError`, {
				name: { en: 'Last error', de: 'Letzter Fehler' },
				type: 'string',
				role: 'text',
				read: true,
				write: false,
				def: '',
			});
			await ensure(`${base}.info.rawResponse`, {
				name: { en: 'Raw /read response (JSON)', de: 'Rohantwort /read (JSON)' },
				type: 'string',
				role: 'json',
				read: true,
				write: false,
				def: '',
			});
		}

		for (const def of controllerStateDefs) {
			await ensure(def.id, {
				name: def.name,
				type: def.type,
				role: def.role,
				unit: def.unit,
				read: true,
				write: false,
				def: defaultFor(def.type),
			});
		}

		for (const def of AGGREGATE_DEFS) {
			await ensure(def.id, {
				name: def.name,
				type: 'number',
				role: def.role,
				unit: def.unit,
				read: true,
				write: false,
				def: 0,
			});
		}

		// info.connection is created via instanceObjects — keep it (and its channel).
		desired.add('info');
		desired.add('info.connection');
		await ensure('info.lastUpdate', {
			name: { en: 'Last successful poll', de: 'Letzte erfolgreiche Abfrage' },
			type: 'string',
			role: 'date',
			read: true,
			write: false,
			def: '',
		});
		await ensure('info.meterBound', {
			name: { en: 'Meter bound by adapter (device mode)', de: 'Zähler vom Adapter gebunden (Geräte-Modus)' },
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			def: false,
		});

		await this.ensureChannels([...desired]);

		// Everything we keep = the desired ids plus all of their ancestor paths.
		const keep = new Set<string>();
		for (const id of desired) {
			keep.add(id);
			const parts = id.split('.');
			for (let i = 1; i < parts.length; i++) {
				keep.add(parts.slice(0, i).join('.'));
			}
		}
		await this.pruneOrphans(keep);
	}

	/**
	 * Ensures a channel object exists for every parent path of the given ids.
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

	/**
	 * Deletes objects in this instance's namespace that are not part of the desired
	 * set — the general "reconcile" step that keeps existing installs clean across
	 * version changes, tree restructures and head-count changes.
	 *
	 * @param keep relative ids (states and channels) that must be preserved
	 */
	private async pruneOrphans(keep: Set<string>): Promise<void> {
		let all: Record<string, ioBroker.Object>;
		try {
			all = await this.getAdapterObjectsAsync();
		} catch (e) {
			this.log.debug(`Object cleanup skipped (cannot list objects): ${errMsg(e)}`);
			return;
		}
		const prefix = `${this.namespace}.`;
		const toDelete: string[] = [];
		for (const fullId of Object.keys(all)) {
			const rel = fullId.startsWith(prefix) ? fullId.slice(prefix.length) : '';
			if (!rel) {
				continue;
			}
			// Only reconcile below roots this adapter manages — user-created objects
			// elsewhere in the namespace are left alone.
			if (!MANAGED_ROOTS.has(rel.split('.')[0])) {
				continue;
			}
			const type = all[fullId]?.type;
			if (type !== 'state' && type !== 'channel' && type !== 'device' && type !== 'folder') {
				continue;
			}
			if (!keep.has(rel)) {
				toDelete.push(rel);
			}
		}
		if (!toDelete.length) {
			return;
		}
		// Delete deepest first so a channel is empty before it is removed.
		toDelete.sort((a, b) => b.split('.').length - a.split('.').length);
		for (const rel of toDelete) {
			try {
				await this.delObjectAsync(rel);
			} catch (e) {
				this.log.debug(`Could not delete obsolete object ${rel}: ${errMsg(e)}`);
			}
		}
		this.log.info(`Cleaned up ${toDelete.length} obsolete object(s).`);
	}

	private async pollLoop(): Promise<void> {
		// Poll all heads in parallel so one slow/unreachable head (timeout) does not
		// stretch the whole cycle; readAndApplyHead isolates its errors per head.
		await Promise.all(this.heads.map(h => this.readAndApplyHead(h)));
		await this.computeAggregates();
		this.pollTimer = this.setTimeout(() => void this.pollLoop(), this.pollIntervalMs);
	}

	/**
	 * Reads one head once and mirrors its fields to heads.<n>.* (without rescheduling).
	 *
	 * @param h the head to poll
	 */
	private async readAndApplyHead(h: HeadRuntime): Promise<void> {
		const base = `heads.${h.index}`;
		try {
			const { reported: data, body } = await h.api.read();
			for (const def of ALL_DEFS) {
				if (!def.derive && !(def.field in data)) {
					continue;
				}
				const raw = def.derive ? def.derive(data) : data[def.field];
				let value: string | number | null = null;
				if (def.type === 'string') {
					value = asString(raw);
				} else if (def.type === 'number') {
					value = roundTo(raw, def.decimals ?? 0, def.scale ?? 1);
				}
				if (value === null) {
					continue;
				}
				const id = `${base}.${def.id}`;
				if (def.write) {
					await this.confirmControlState(id, value);
				} else {
					await this.setStateChangedAsync(id, value, true);
				}
			}
			await this.guardMeterMode(h, data);
			await this.setStateChangedAsync(`${base}.info.rawResponse`, body, true);

			h.soc = num(data.SC);
			h.bp = num(data.BP);
			h.gp = num(data.GP);
			h.packs = Math.max(1, num(data.ON) ?? 1);
			// MG carries the head's max grid-tied output; if missing, derive the model
			// limit (500 → 800 W, 500 PRO → 2400 W) instead of assuming a PRO.
			h.maxPower = num(data.MG) ?? fallbackMaxPower(data);
			h.socMin = num(data.SI) ?? num(data.SO);
			h.socMax = num(data.SA);
			// Anti-windup feedback: let the controller compare commanded GS vs. actual GP.
			if (h.gp !== undefined) {
				this.controller?.noteReportedGp(h.index, h.gp);
			}

			if (!h.online) {
				h.online = true;
				await this.setState(`${base}.info.online`, true, true);
			}
			await this.setStateChangedAsync(`${base}.info.lastError`, '', true);
		} catch (e) {
			if (h.online || h.soc === undefined) {
				h.online = false;
				await this.setStateChangedAsync(`${base}.info.online`, false, true);
				// The head may reboot with GS=0 — drop the remembered setpoint.
				this.controller?.forgetHead(h.index);
			}
			await this.setStateChangedAsync(`${base}.info.lastError`, errMsg(e), true);
			this.log.warn(`Head ${h.index} (${h.host}) poll failed: ${errMsg(e)}`);
		}
	}

	/** Computes the combined view across all online heads. */
	private async computeAggregates(): Promise<void> {
		const online = this.heads.filter(h => h.online);
		await this.setStateChangedAsync('total.onlineCount', online.length, true);
		await this.setStateChangedAsync(
			'total.gridPower',
			Math.round(online.reduce((acc, h) => acc + (h.gp ?? 0), 0)),
			true,
		);
		await this.setStateChangedAsync(
			'total.batteryPower',
			Math.round(online.reduce((acc, h) => acc + (h.bp ?? 0), 0)),
			true,
		);
		await this.setStateChangedAsync(
			'total.maxPower',
			Math.round(online.reduce((acc, h) => acc + h.maxPower, 0)),
			true,
		);
		const withSoc = online.filter(h => h.soc !== undefined);
		if (withSoc.length) {
			const weight = withSoc.reduce((acc, h) => acc + h.packs, 0) || 1;
			const soc = withSoc.reduce((acc, h) => acc + (h.soc as number) * h.packs, 0) / weight;
			await this.setStateChangedAsync('total.soc', Math.round(soc * 10) / 10, true);
		}

		const connected = online.length > 0;
		await this.setStateChangedAsync('info.connection', connected, true);
		if (connected) {
			await this.setStateChangedAsync('info.lastUpdate', new Date().toISOString(), true);
		}
	}

	/**
	 * Mirrors a confirmed device value onto a writable control state with ack=true,
	 * clearing a pending (ack=false) command once the device echoes the value back.
	 *
	 * @param id full control state id
	 * @param value the value the device currently reports
	 */
	private async confirmControlState(id: string, value: string | number): Promise<void> {
		// Cheap in-memory shortcut: we confirmed exactly this value before and no user
		// command invalidated it since (handleControlWrite clears the entry).
		if (this.confirmedCache.get(id) === value) {
			return;
		}
		const cur = await this.getStateAsync(id);
		if (!cur || cur.val !== value || cur.ack !== true) {
			await this.setStateAsync(id, { val: value, ack: true });
		}
		this.confirmedCache.set(id, value);
	}

	/**
	 * Writes the device fields (MM/MD) required by the active control mode for every
	 * head, so a leftover or externally-set mode cannot lame the chosen control path.
	 *
	 * @param reason context shown in the log line
	 */
	private async enforceMode(reason: string): Promise<void> {
		if (this.controlMode === 'controller') {
			for (const h of this.heads) {
				await this.writeHead(h, { MM: 0, MD: '' }, reason);
			}
			await this.setMeterBoundByAdapter(false);
		} else if (this.controlMode === 'device') {
			const h = this.heads[0];
			if (!h || !this.meterMd) {
				return; // misconfigured — already warned, leave the device alone
			}
			await this.writeHead(h, { MM: 1, MD: this.meterMd }, reason);
			await this.setMeterBoundByAdapter(true);
		} else if (await this.isMeterBoundByAdapter()) {
			// off mode: release only a binding THIS adapter created earlier (device mode).
			const h = this.heads[0];
			if (h) {
				await this.writeHead(h, { MM: 0, MD: '' }, 'off-cleanup');
			}
			await this.setMeterBoundByAdapter(false);
			this.log.info('Releasing the adapter-managed meter binding (control mode is now off).');
		}
	}

	/**
	 * Writes a payload to one head, logging the outcome without aborting the others.
	 *
	 * @param h the target head
	 * @param payload device fields to write
	 * @param reason context shown in the log line
	 */
	private async writeHead(h: HeadRuntime, payload: Record<string, string | number>, reason: string): Promise<void> {
		try {
			await h.api.write(payload);
			if (this.controlMode !== 'off') {
				this.log.info(
					`Head ${h.index}: enforced ${this.controlMode} mode (${reason}): ${JSON.stringify(payload)}.`,
				);
			}
		} catch (e) {
			this.log.warn(`Head ${h.index}: could not apply ${this.controlMode} mode: ${errMsg(e)}`);
		}
	}

	/** Whether the adapter currently holds a device-native meter binding it created. */
	private async isMeterBoundByAdapter(): Promise<boolean> {
		const st = await this.getStateAsync('info.meterBound');
		return !!st?.val;
	}

	/**
	 * Persists whether the adapter currently holds a meter binding (device mode).
	 *
	 * @param bound
	 */
	private async setMeterBoundByAdapter(bound: boolean): Promise<void> {
		await this.setStateAsync('info.meterBound', { val: bound, ack: true });
	}

	/**
	 * Keeps a head's self-consumption mode (MM) consistent with the chosen control
	 * mode on every poll; re-asserts and warns once on mismatch.
	 *
	 * @param h the polled head
	 * @param data its latest reported state
	 */
	private async guardMeterMode(h: HeadRuntime, data: ReportedState): Promise<void> {
		if (this.controlMode === 'off') {
			return;
		}
		if (this.controlMode === 'device' && (h.index !== 1 || !this.meterMd)) {
			return;
		}
		const want = this.controlMode === 'controller' ? 0 : 1;
		const mm = num(data.MM);
		if (mm === undefined || mm === want) {
			this.mmGuardWarned.set(h.index, false);
			return;
		}
		if (!this.mmGuardWarned.get(h.index)) {
			this.mmGuardWarned.set(h.index, true);
			this.log.warn(
				`Head ${h.index}: MM=${mm} does not match ${this.controlMode} mode (expected ${want}) — re-asserting. Another script or the app may be changing MM.`,
			);
		}
		const payload = this.controlMode === 'controller' ? { MM: 0, MD: '' } : { MM: 1, MD: this.meterMd };
		await this.writeHead(h, payload, 'guard');
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			return;
		}
		// Foreign grid-power source: drive the controller on every update (ack=true).
		if (this.controller && id === this.gridStateId) {
			void this.controller.onGridPower(Number(state.val));
			return;
		}
		// Own control states: only act on user commands (ack=false).
		if (state.ack) {
			return;
		}
		const rel = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
		void this.handleControlWrite(rel, state);
	}

	/**
	 * Sends a writable control field of one head to its device and confirms via re-read.
	 *
	 * @param relId relative state id, e.g. "heads.2.control.GS"
	 * @param state the new state
	 */
	private async handleControlWrite(relId: string, state: ioBroker.State): Promise<void> {
		const m = /^heads\.(\d+)\.(.+)$/.exec(relId);
		if (!m) {
			return;
		}
		const def = this.controlMap.get(m[2]);
		const h = this.heads.find(x => x.index === Number(m[1]));
		if (!def || !h) {
			return;
		}
		if (def.field === 'GS' && this.controller) {
			// The controller owns GS; a manual write would fight it and desync its base.
			this.log.warn(
				`Head ${h.index}: ignoring manual GS write — the controller owns GS in controller mode (set the control mode to off for manual GS control).`,
			);
			return;
		}
		this.confirmedCache.delete(relId);
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
				this.log.warn(`Ignoring invalid value for ${relId}: ${state.val}`);
				return;
			}
			payload = { [def.field]: n };
		}

		// MM/MD coupling, matching the official integration.
		applyMeterModeCoupling(def.field, payload);

		try {
			await h.api.write(payload);
			this.log.info(`Head ${h.index}: wrote ${JSON.stringify(payload)} to device.`);
			if (def.field !== 'RT') {
				this.setTimeout(() => void this.readAndApplyHead(h), WRITE_CONFIRM_DELAY_MS);
			}
		} catch (e) {
			this.log.warn(`Head ${h.index}: write ${def.field} failed: ${errMsg(e)}`);
		}
	}

	/**
	 * Handles admin messages — currently the "test all heads" connectivity probe.
	 *
	 * @param obj the incoming message
	 */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		if (!obj || typeof obj !== 'object' || obj.command !== 'testConnections') {
			return;
		}
		const msg = (obj.message ?? {}) as { heads?: { host?: string; label?: string }[] };
		const heads = Array.isArray(msg.heads) ? msg.heads : [];
		const timeoutMs = Math.max(1000, Math.round(cfgNum(this.config.requestTimeout, 8000)));
		const lines: string[] = [];
		let failures = 0;
		let i = 0;
		for (const h of heads) {
			i++;
			const host = (h?.host || '').trim();
			const name = (h?.label || '').trim() || `Head ${i}`;
			if (!host) {
				continue; // empty optional slot
			}
			try {
				const { reported } = await new SunEnergyXtApi(host, timeoutMs).read();
				const model = asString(reported.DevType) || 'SunEnergyXT';
				const soc = num(reported.SC);
				lines.push(`• ${name} (${host}): OK — ${model}${soc !== undefined ? `, SoC ${soc}%` : ''}`);
			} catch (e) {
				failures++;
				lines.push(`• ${name} (${host}): unreachable — ${errMsg(e)}`);
			}
		}
		const text = lines.length ? lines.join('\n') : 'No head configured to test.';
		// Show as an error (red) if anything failed or nothing was testable, else as a result (green).
		const response = failures > 0 || !lines.length ? { error: text } : { result: text };
		if (obj.callback) {
			this.sendTo(obj.from, obj.command, response, obj.callback);
		}
	}

	private onUnload(callback: () => void): void {
		void (async () => {
			try {
				if (this.pollTimer) {
					this.clearTimeout(this.pollTimer);
				}
				if (this.controller) {
					this.controller.stop();
					// Leaving controller mode (stop/restart/mode change): without this the
					// heads would keep executing the last setpoint forever, unwatched
					// (e.g. full-power grid charging). Best effort within a short budget.
					await Promise.race([
						this.neutralizeAllGs(),
						new Promise(resolve => setTimeout(resolve, UNLOAD_NEUTRALIZE_BUDGET_MS)),
					]);
				}
			} catch {
				// ignore — we must always call the callback
			} finally {
				callback();
			}
		})();
	}

	/** Writes a neutral GS=0 to every reachable head (used during unload). */
	private async neutralizeAllGs(): Promise<void> {
		await Promise.all(
			this.heads
				.filter(h => h.online)
				.map(async h => {
					try {
						await h.api.write({ GS: 0 });
						this.log.info(`Head ${h.index}: GS neutralized to 0 (controller shutdown).`);
					} catch (e) {
						this.log.warn(`Head ${h.index}: could not neutralize GS: ${errMsg(e)}`);
					}
				}),
		);
	}

	/** Starts the multi-head self-consumption controller (controller mode). */
	private async setupController(): Promise<void> {
		this.gridStateId = (this.config.gridPowerStateId || '').trim();
		if (!this.gridStateId) {
			this.log.warn(
				'Controller mode selected but no grid-power source state configured — controller not started.',
			);
			return;
		}
		// cfgNum keeps explicit zeros (gain/dead bands of 0 must not become defaults).
		const cfg: ControllerConfig = {
			gain: cfgNum(this.config.controllerGain, 0.3),
			deadBandW: Math.max(0, cfgNum(this.config.controllerDeadBandW, 20)),
			minIntervalMs: Math.max(1000, cfgNum(this.config.controllerMinIntervalMs, 5000)),
			writeDeadBandW: Math.max(0, cfgNum(this.config.controllerWriteDeadBandW, 10)),
			inverted: !!this.config.gridPowerInverted,
			warnSec: Math.max(5, cfgNum(this.config.watchdogWarnSec, 30)),
			failsafeSec: Math.max(10, cfgNum(this.config.watchdogFailsafeSec, 180)),
		};
		const hooks: ControllerHooks = {
			getHeads: () => this.headStates(),
			writeGs: async (index, gs) => {
				const h = this.heads.find(x => x.index === index);
				if (h) {
					await h.api.write({ GS: gs });
				}
			},
			reflectGs: async (index, gs) => {
				const id = `heads.${index}.control.GS`;
				await this.setStateChangedAsync(id, gs, true);
				// Keep the confirm cache in sync so the next poll does not re-write it.
				this.confirmedCache.set(id, gs);
			},
		};
		this.controller = new MultiHeadController(this, hooks, this.gridStateId, cfg);
		await this.subscribeForeignStatesAsync(this.gridStateId);
		await this.controller.start();
		this.log.info(
			`Self-consumption controller active on grid source "${this.gridStateId}" across ${this.heads.length} head(s).`,
		);
	}

	/** Maps the current head runtime to the pure HeadState used by the controller and split. */
	private headStates(): HeadState[] {
		return this.heads.map(h => ({
			index: h.index,
			online: h.online,
			gp: h.gp ?? 0,
			soc: h.soc ?? 0,
			socMin: h.socMin ?? 0,
			socMax: h.socMax ?? 100,
			maxPower: h.maxPower,
		}));
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Model-based power limit used when the device does not report MG:
 * 500 (PK=1) → 800 W, 500 PRO (PK=2) → 2400 W; unknown models assume a PRO.
 *
 * @param data the head's reported state
 */
function fallbackMaxPower(data: ReportedState): number {
	const pk = num(data.PK);
	if (pk === 1) {
		return 800;
	}
	if (pk === 2) {
		return 2400;
	}
	const devType = typeof data.DevType === 'string' ? data.DevType : '';
	if (devType && !/pro/i.test(devType)) {
		return 800;
	}
	return 2400;
}

/**
 * Parses an unknown API value to a finite number, or undefined.
 *
 * @param value
 */
function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
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
