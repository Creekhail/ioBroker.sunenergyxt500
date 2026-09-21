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
import { NAME_TRANSLATIONS } from './lib/name-translations';
import { pollBackoffMs, pollStaggerMs } from './lib/poll-schedule';
import type { HeadState } from './lib/split';
import type { LocalizedName, StateDef } from './lib/states';
import {
	applyMeterModeCoupling,
	buildMeterMd,
	cfgNum,
	controlDefs,
	measurementDefs,
	roundTo,
	subscribedControlPatterns,
} from './lib/states';
import { asString, errMsg, fallbackMaxPower, hostKey, num } from './lib/values';

/** Delay before re-reading the device to confirm a control write. */
const WRITE_CONFIRM_DELAY_MS = 1500;

/** Maximum number of heads a single instance manages. */
const MAX_HEADS = 3;

/**
 * Consecutive failed polls before a head is dropped from the control loop.
 *
 * `info.online` already flips on the first failure — that is reporting. Removing a
 * head from regulation is a physical decision: it stops being written to while it
 * keeps executing its last setpoint, and with several heads the others start
 * compensating for a value that is still live. One missed poll on a weak Wi-Fi link
 * is not enough evidence for that.
 */
const CONTROL_DROP_AFTER_FAILURES = 3;

/**
 * Deadline for a regulation write, shorter than the configured request timeout.
 *
 * The control loop holds one lock for the whole cycle, so the next cycle cannot start
 * until the slowest head has answered. With the full 8 s timeout a single sluggish head
 * turns the 1 s tier into an 8 s tier for every head. A setpoint that takes longer than
 * this to arrive is stale anyway — better to give up on it and recompute.
 */
const CONTROL_WRITE_TIMEOUT_MS = 2500;

/**
 * What a head can draw from the grid, and the ceiling for its inverter limit, in W.
 *
 * Both are documented as the same figure for the 500 and the 500 PRO; only the
 * grid-connected *output* (MG, and with it GS upwards) is lower on a 500. Keeping
 * this apart from `maxPower` is what stops an export cap from throttling charging.
 */
const DEVICE_MAX_W = 2400;

/** All device-field definitions (measurements + controls), precomputed once. */
const ALL_DEFS = [...measurementDefs, ...controlDefs];

/**
 * Top-level ids of the current object tree. The startup cleanup only reconciles below
 * these roots, and even there only objects this adapter created (see OWNER_MARK).
 */
const MANAGED_ROOTS = new Set(['heads', 'total', 'controller', 'info']);

/**
 * Roots of the pre-0.2.0 flat tree. These are removed wholesale on upgrade: the layout
 * is gone, nothing recreates it, and it predates the ownership marker so there is
 * nothing to check against.
 */
const LEGACY_ROOTS = new Set(['battery', 'grid', 'load', 'pv', 'system', 'device', 'meter', 'ups', 'fault', 'control']);

/**
 * Written into `native` of every object this adapter creates. The cleanup deletes only
 * objects carrying it, so a state a user added under e.g. `heads.1.` survives a
 * restart instead of being reconciled away. Existing installations acquire the mark on
 * the next start, because the same code path also extends objects that already exist.
 */
const OWNER_MARK = { createdBy: 'sunenergyxt500' } as const;

/**
 * Time budget for writing a neutral GS=0 to the heads during unload.
 *
 * Must stay comfortably below `common.stopTimeout` in io-package.json: ioBroker
 * terminates the adapter once that elapses, whether or not the unload callback has
 * been reached, so a budget larger than the stop timeout would cut the neutralisation
 * short instead of protecting it.
 */
const UNLOAD_NEUTRALIZE_BUDGET_MS = 2000;

/**
 * Expands a hand-written en/de name with the generated machine translations for the
 * other ioBroker languages (en/de take precedence over the generated entries).
 *
 * @param name the hand-written bilingual name
 */
function loc(name: LocalizedName): ioBroker.Translated {
	return { ...(NAME_TRANSLATIONS[name.en] ?? {}), ...name };
}

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
		// Explicitly "of the storages": this is the sum of the heads' own grid ports, not
		// the house connection. The controller's view of the latter is controller.gridPower.
		name: {
			en: 'Storage grid-port power, total (+feed-in)',
			de: 'Netzport-Leistung der Speicher, gesamt (+Einspeisung)',
		},
	},
	{
		id: 'total.maxPower',
		role: 'value.power',
		unit: 'W',
		// The sum of MG, so it is what the plant may put OUT. It says nothing about what
		// it may take in — those are separate limits on the device.
		name: {
			en: 'Total grid-tied output limit (online heads)',
			de: 'Gesamt-Netzausgangsgrenze (Online-Köpfe)',
		},
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
	/**
	 * Set after the first successful poll since adapter start. That first cycle
	 * force-writes every delivered value (setState instead of setStateChanged) so
	 * the initialization quality 0x20 is cleared and every delivered state carries
	 * a timestamp at least as fresh as the adapter start.
	 */
	firstPollDone?: boolean;
	/** Latest snapshot used for the aggregates and (later) the controller split. */
	soc?: number;
	bp?: number;
	gp?: number;
	/** Load-port power LP in W — 0 on installations with nothing wired to that port. */
	lp?: number;
	/** Total PV power in W. */
	pv?: number;
	/** Discharge-side SoC hysteresis band in percent, from SI1. */
	socHysteresisDischarge?: number;
	/** Charge-side SoC hysteresis band in percent, from SA1. */
	socHysteresisCharge?: number;
	packs: number;
	maxPower: number;
	/**
	 * The head's rating in W, from the model alone — 800 for a 500, 2400 for a PRO.
	 *
	 * Deliberately not `maxPower`: that follows MG, so an owner who has capped feed-in
	 * would be locked out of raising it again by a bound derived from their own setting.
	 */
	modelMax?: number;
	socMin?: number;
	socMax?: number;
	/** Consecutive failed polls; drives the back-off in nextPollDelay(). */
	pollFailures: number;
}

class Sunenergyxt500 extends utils.Adapter {
	private heads: HeadRuntime[] = [];
	private pollIntervalMs = 5000;
	/** Active control mode: off (monitoring), controller (Mode B) or device (Mode A, single head). */
	private controlMode: 'off' | 'controller' | 'device' = 'off';
	/**
	 * True when 'off' is a fallback from a configuration the adapter refused, not the
	 * operator's choice.
	 *
	 * Those fallbacks promise to leave the devices as they are, so they must not release
	 * the meter binding: that would switch the device's own regulation off while the
	 * adapter regulation they asked for cannot start either.
	 */
	private controlModeForced = false;
	/** Built meter-connection string (MD) for device mode; '' when unconfigured. */
	private meterMd = '';
	/** Per-head flag whether the MM-mismatch warning was already logged. */
	private readonly mmGuardWarned = new Map<number, boolean>();
	/** Per-head flag whether the "no meter bound" warning was already logged. */
	private readonly msGuardWarned = new Map<number, boolean>();
	/** True while a meter-binding write is still owed to the device. */
	private meterMdPending = false;
	/** One poll timer per head index — the heads run on independent, staggered cycles. */
	private readonly pollTimers = new Map<number, ioBroker.Timeout>();
	/** Active multi-head controller (controller mode only). */
	private controller?: MultiHeadController;
	/** Foreign grid-power source state id the controller subscribes to. */
	private gridStateId = '';
	/** Whether the "grid source writes with ack=false" warning was already logged. */
	private gridAckWarned = false;
	/** Whether the "grid source is not numeric" warning was already logged. */
	private gridValueWarned = false;
	/** relative control state id (e.g. "control.GS") → its definition */
	private readonly controlMap = new Map<string, StateDef>();
	/** Last value confirmed (ack=true) per control state — avoids a DB read per field and poll. */
	private readonly confirmedCache = new Map<string, string | number | boolean>();
	/** Whether the aggregates were force-written once since start (clears quality 0x20). */
	private aggregatesForced = false;
	/** True from the moment unload starts; blocks device writes from in-flight work. */
	private stopping = false;
	/** True while a leftover setpoint from an earlier run still has to be cleared. */
	private gsCleanupPending = false;
	/** Hosts already neutralised during that cleanup, keyed by hostKey(). */
	private readonly gsCleanupDone = new Set<string>();
	/** Hosts the pending cleanup still has to reach, as recorded by the previous run. */
	private gsCleanupHosts: string[] = [];

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
			// Normalise before comparing: "192.168.1.5", "192.168.1.5/" and
			// "http://192.168.1.5" are the same device, and two entries pointing at one
			// head would halve the effective power without any warning.
			const key = hostKey(host);
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
				api: new SunEnergyXtApi(host, timeoutMs, this),
				online: false,
				packs: 1,
				maxPower: 2400,
				pollFailures: 0,
			});
		}

		if (!this.heads.length) {
			this.log.error(
				'No storage head configured. Please add at least one head (host/IP) in the adapter settings.',
			);
			return;
		}

		this.controlMode = this.config.controlMode || 'off';
		this.controlModeForced = false;
		if (this.controlMode === 'device' && this.heads.length > 1) {
			this.log.error(
				`Device self-regulation is only available with a single head, but ${this.heads.length} are configured — falling back to monitoring (off). Use the adapter controller for multiple heads.`,
			);
			this.controlMode = 'off';
			this.controlModeForced = true;
		}

		for (const def of ALL_DEFS) {
			if (def.write) {
				this.controlMap.set(def.id, def);
			}
		}

		await this.createObjects();
		for (const pattern of subscribedControlPatterns(ALL_DEFS)) {
			this.subscribeStates(pattern);
		}

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

		// Controller mode without a source cannot regulate. Catching that here, *before*
		// enforceMode() switches the devices' own regulation off, avoids the worst of both
		// worlds: device regulation disabled and no adapter regulation taking over.
		if (this.controlMode === 'controller') {
			const src = (this.config.gridPowerStateId || '').trim();
			if (!src) {
				this.log.error(
					'Controller mode is selected but no grid-power source state is configured. Falling back ' +
						"to monitoring (off) and leaving the devices' own regulation as it is — configure the " +
						'source state, then restart the instance. A setpoint left over from an earlier run is ' +
						'still cleared: nothing would be watching it.',
				);
				this.controlMode = 'off';
				this.controlModeForced = true;
			} else if (src.startsWith(`${this.name}.`)) {
				// Our own states close the loop on itself. total.gridPower is the tempting one: it
				// looks like a grid reading but is the storages’ own output, with the opposite sign.
				this.log.error(
					`The configured grid-power source "${src}" is one of this adapter's own states. That feeds ` +
						'the controller its own output and would drive it to the limit. Point it at your meter ' +
						'adapter instead. Falling back to monitoring (off).',
				);
				this.controlMode = 'off';
				this.controlModeForced = true;
			}
		}

		// Bring every head into the state required by the chosen control mode before polling.
		await this.enforceMode('startup');

		if (this.controlMode === 'controller') {
			const inherited = await this.isGsOwnedByAdapter();
			await this.setupController(inherited);
		} else {
			// Leave no stale controller telemetry behind: in off/device mode those states
			// would otherwise keep showing the last run's status and setpoint forever,
			// which reads as if a controller were still running.
			await this.setState('controller.status', { val: '', ack: true });
			await this.setState('controller.totalTarget', { val: 0, ack: true });
			await this.setState('controller.gridPower', { val: 0, ack: true });
			// Not regulating any more, but a previous run may have left a setpoint behind.
			await this.resumeGsOwnership();
		}

		this.log.info(
			`Control mode: ${this.controlMode}. Polling ${this.heads.length} head(s) every ${this.pollIntervalMs / 1000}s` +
				`${this.heads.length > 1 ? ', staggered' : ''}.`,
		);
		this.startPolling();
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
			await this.setObjectNotExistsAsync(id, { type: 'state', common, native: { ...OWNER_MARK } });
			// Merge the current definition onto existing objects so role/type/name
			// updates reach old installations (extend keeps user data like common.custom).
			// The same call backfills the ownership marker on installs that predate it.
			await this.extendObject(id, { common, native: { ...OWNER_MARK } });
		};

		// The heads container must be a folder: a device below a channel violates the
		// required device→channel→state hierarchy. Create-then-extend like ensure() does,
		// which also migrates installations where it was created as a channel before —
		// extendObject merges deeply, so the type is overwritten while anything the owner
		// added survives.
		desired.add('heads');
		const headsFolder: ioBroker.SettableObject = {
			type: 'folder',
			common: { name: { en: 'Storage heads', de: 'Speicherköpfe' } },
			native: { ...OWNER_MARK },
		};
		await this.setObjectNotExistsAsync('heads', headsFolder);
		await this.extendObject('heads', headsFolder);

		for (const h of this.heads) {
			const base = `heads.${h.index}`;
			const name = h.label || `Head ${h.index}`;
			desired.add(base);
			await this.setObjectNotExistsAsync(base, {
				type: 'device',
				common: { name },
				native: { ...OWNER_MARK },
			});
			await this.extendObject(base, { common: { name }, native: { ...OWNER_MARK } });

			for (const def of ALL_DEFS) {
				await ensure(`${base}.${def.id}`, {
					name: loc(def.name),
					type: def.type,
					role: def.role,
					unit: def.unit,
					read: true,
					write: !!def.write,
					states: def.states,
					// Carried into the object so the admin UI and other clients see the
					// same bounds the runtime enforces on a manual write.
					min: def.min,
					max: def.max,
					def: defaultFor(def.type),
				});
			}
			await ensure(`${base}.info.online`, {
				name: loc({ en: 'Head reachable', de: 'Kopf erreichbar' }),
				type: 'boolean',
				role: 'indicator.reachable',
				read: true,
				write: false,
				def: false,
			});
			await ensure(`${base}.info.lastError`, {
				name: loc({ en: 'Last error', de: 'Letzter Fehler' }),
				type: 'string',
				role: 'text',
				read: true,
				write: false,
				def: '',
			});
			await ensure(`${base}.info.rawResponse`, {
				name: loc({ en: 'Raw /read response (JSON)', de: 'Rohantwort /read (JSON)' }),
				type: 'string',
				role: 'json',
				read: true,
				write: false,
				def: '',
			});
		}

		for (const def of controllerStateDefs) {
			await ensure(def.id, {
				name: loc(def.name),
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
				name: loc(def.name),
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
			name: loc({ en: 'Last successful poll', de: 'Letzte erfolgreiche Abfrage' }),
			type: 'string',
			role: 'date',
			read: true,
			write: false,
			def: '',
		});
		await ensure('info.meterBound', {
			name: loc({
				en: 'Meter bound by adapter (device mode)',
				de: 'Zähler vom Adapter gebunden (Geräte-Modus)',
			}),
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			def: false,
		});
		await ensure('info.gsOwned', {
			name: loc({
				en: 'Adapter holds a grid setpoint on the heads',
				de: 'Adapter hält einen Netz-Sollwert auf den Köpfen',
			}),
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
	 * @param ids relative state ids whose ancestor channels must exist
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
				native: { ...OWNER_MARK },
			});
			await this.extendObject(p, { native: { ...OWNER_MARK } });
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
			const root = rel.split('.')[0];
			const obj = all[fullId];
			const type = obj?.type;
			if (type !== 'state' && type !== 'channel' && type !== 'device' && type !== 'folder') {
				continue;
			}
			// The 0.1.x flat tree goes entirely: that layout is no longer created, and it
			// predates the ownership marker, so there is nothing to test it against.
			if (LEGACY_ROOTS.has(root)) {
				toDelete.push(rel);
				continue;
			}
			if (!MANAGED_ROOTS.has(root) || keep.has(rel)) {
				continue;
			}
			// Inside our own tree, delete only what we created. A state a user added
			// under heads.<n>. is theirs — reconciling the tree is not a licence to
			// remove other people's data.
			if ((obj?.native as Record<string, unknown> | undefined)?.createdBy !== OWNER_MARK.createdBy) {
				this.log.debug(`Keeping ${rel}: not created by this adapter.`);
				continue;
			}
			toDelete.push(rel);
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

	/**
	 * Starts one independent poll cycle per head, staggered so the heads do not
	 * transmit at the same instant. Independent cycles (instead of one loop over all
	 * heads) keep a slow or unreachable head from delaying the others, which a plain
	 * sequential loop would do.
	 */
	private startPolling(): void {
		for (const h of this.heads) {
			this.schedulePoll(h, pollStaggerMs(h.index, this.heads.length, this.pollIntervalMs));
		}
	}

	/**
	 * Schedules this head's next poll, replacing any pending timer for it.
	 *
	 * @param h the head to schedule
	 * @param delayMs delay until the next poll
	 */
	private schedulePoll(h: HeadRuntime, delayMs: number): void {
		const pending = this.pollTimers.get(h.index);
		if (pending) {
			this.clearTimeout(pending);
			this.pollTimers.delete(h.index);
		}
		// Returns undefined once the adapter is unloading — then there is nothing to track.
		const timer = this.setTimeout(() => void this.pollHead(h), delayMs);
		if (timer) {
			this.pollTimers.set(h.index, timer);
		}
	}

	/**
	 * Polls one head and reschedules its own cycle.
	 *
	 * @param h the head to poll
	 */
	private async pollHead(h: HeadRuntime): Promise<void> {
		this.pollTimers.delete(h.index);
		try {
			const ok = await this.readAndApplyHead(h);
			h.pollFailures = ok ? 0 : h.pollFailures + 1;
			await this.computeAggregates();
		} catch (e) {
			// Device errors are handled in readAndApplyHead; anything here is unexpected. The
			// reschedule has to happen regardless, or this head is never polled again.
			h.pollFailures++;
			this.log.warn(`Head ${h.index}: unexpected error during poll: ${errMsg(e)}`);
		} finally {
			this.schedulePoll(h, pollBackoffMs(this.pollIntervalMs, h.pollFailures));
		}
	}

	/**
	 * Reads one head once and mirrors its fields to heads.<n>.* (without rescheduling).
	 *
	 * @param h the head to poll
	 * @returns whether the read succeeded
	 */
	private async readAndApplyHead(h: HeadRuntime): Promise<boolean> {
		const base = `heads.${h.index}`;
		try {
			const { reported: data, body } = await h.api.read();
			// First successful cycle after start: force-write every delivered value so
			// the creation quality 0x20 is cleared even when the value equals the
			// object default (setStateChanged would skip it forever otherwise).
			const force = !h.firstPollDone;
			for (const def of ALL_DEFS) {
				if (!def.derive && !(def.field in data)) {
					continue;
				}
				const raw = def.derive ? def.derive(data) : data[def.field];
				let value: string | number | boolean | null = null;
				if (def.type === 'string') {
					value = asString(raw);
				} else if (def.type === 'number') {
					value = roundTo(raw, def.decimals ?? 0, def.scale ?? 1);
				} else if (def.type === 'boolean' && def.role !== 'button') {
					// Device reports switches as 0/1; buttons (RT) are never read back.
					const n = num(raw);
					value = n === undefined ? null : n !== 0;
				}
				if (value === null) {
					continue;
				}
				const id = `${base}.${def.id}`;
				if (force) {
					await this.setState(id, { val: value, ack: true });
					if (def.write) {
						this.confirmedCache.set(id, value);
					}
				} else if (def.write) {
					await this.confirmControlState(id, value);
				} else {
					await this.setStateChangedAsync(id, value, true);
				}
			}
			h.firstPollDone = true;
			await this.guardMeterMode(h, data);
			await this.setStateChangedAsync(`${base}.info.rawResponse`, body, true);

			h.soc = num(data.SC);
			h.bp = num(data.BP);
			h.gp = num(data.GP);
			h.lp = num(data.LP);
			h.pv = num(data.PV);
			h.packs = Math.max(1, num(data.ON) ?? 1);
			// MG carries the head's max grid-tied output; if missing, derive the model
			// limit (500 → 800 W, 500 PRO → 2400 W) instead of assuming a PRO.
			const modelMax = fallbackMaxPower(data);
			h.maxPower = num(data.MG) ?? modelMax;
			h.socMin = num(data.SI) ?? num(data.SO);
			h.socMax = num(data.SA);
			// The device resumes only once the charge has moved this far back inside its limits.
			// Kept apart by direction: SI1 guards the floor, SA1 the ceiling.
			h.socHysteresisDischarge = num(data.SI1);
			h.socHysteresisCharge = num(data.SA1);
			// After the snapshot, not inside it: this one awaits, and the fields below it
			// decide whether the head is regulatable at all.
			await this.applyModelLimit(h, modelMax);
			// Anti-windup feedback: let the controller compare commanded GS vs. actual GP.
			if (h.gp !== undefined) {
				this.controller?.noteReportedGp(h.index, h.gp);
			}
			// GS is echoed back by the device, so a mismatch with the commanded value
			// exposes a second writer (vendor app, other automation) rather than a limit.
			const reportedGs = num(data.GS);
			if (reportedGs !== undefined) {
				this.controller?.noteReportedGs(h.index, reportedGs);
			}

			if (!h.online) {
				h.online = true;
				await this.setState(`${base}.info.online`, true, true);
			}
			await this.setStateChangedAsync(`${base}.info.lastError`, '', true);
			// A head that answers again is the moment to finish a pending cleanup.
			await this.retryGsCleanup(h);
			return true;
		} catch (e) {
			// `info.online` flips on the first failure; dropping the head out of the *control*
			// loop is costlier, because an unregulated head keeps executing its last setpoint.
			// See CONTROL_DROP_AFTER_FAILURES.
			if (h.online) {
				h.online = false;
				await this.setStateChangedAsync(`${base}.info.online`, false, true);
			}
			if (h.pollFailures + 1 >= CONTROL_DROP_AFTER_FAILURES) {
				// The head may reboot with GS=0 — drop the remembered setpoint.
				this.controller?.forgetHead(h.index);
			}
			await this.setStateChangedAsync(`${base}.info.lastError`, errMsg(e), true);
			this.log.warn(`Head ${h.index} (${h.host}) poll failed: ${errMsg(e)}`);
			return false;
		}
	}

	/** Computes the combined view across all online heads. */
	private async computeAggregates(): Promise<void> {
		const online = this.heads.filter(h => h.online);
		// First cycle after start: force-write so the creation quality 0x20 clears
		// even when an aggregate equals its object default (e.g. gridPower 0).
		const force = !this.aggregatesForced && online.length > 0;
		const write = async (id: string, val: number): Promise<void> => {
			if (force) {
				await this.setState(id, { val, ack: true });
			} else {
				await this.setStateChangedAsync(id, val, true);
			}
		};
		await write('total.onlineCount', online.length);
		await write('total.gridPower', Math.round(online.reduce((acc, h) => acc + (h.gp ?? 0), 0)));
		await write('total.batteryPower', Math.round(online.reduce((acc, h) => acc + (h.bp ?? 0), 0)));
		await write('total.maxPower', Math.round(online.reduce((acc, h) => acc + h.maxPower, 0)));
		const withSoc = online.filter(h => h.soc !== undefined);
		if (withSoc.length) {
			const weight = withSoc.reduce((acc, h) => acc + h.packs, 0) || 1;
			const soc = withSoc.reduce((acc, h) => acc + (h.soc as number) * h.packs, 0) / weight;
			await write('total.soc', Math.round(soc * 10) / 10);
		}
		if (force) {
			this.aggregatesForced = true;
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
	private async confirmControlState(id: string, value: string | number | boolean): Promise<void> {
		// Cheap in-memory shortcut: we confirmed exactly this value before and no user
		// command invalidated it since (handleControlWrite clears the entry).
		if (this.confirmedCache.get(id) === value) {
			return;
		}
		const cur = await this.getStateAsync(id);
		if (!cur || cur.val !== value || cur.ack !== true) {
			await this.setState(id, { val: value, ack: true });
		}
		this.confirmedCache.set(id, value);
	}

	/**
	 * The upper bound a manual write to this field must respect on this head.
	 *
	 * @param def the field being written
	 * @param h the head it is being written to
	 */
	private effectiveMax(def: StateDef, h: HeadRuntime): number | undefined {
		if (!def.modelLimited || def.max === undefined || h.modelMax === undefined) {
			return def.max;
		}
		return Math.min(def.max, h.modelMax);
	}

	/**
	 * Narrows the output fields' upper bound to what this head's model is rated for,
	 * once a poll has said which model it is.
	 *
	 * The objects are created before the first poll, when the model is still unknown, so
	 * they start at the PRO bound. Writing them on every poll would be a database update
	 * per head per cycle, hence the change check.
	 *
	 * @param h the polled head
	 * @param modelMax the head's rating in W, derived from the model
	 */
	private async applyModelLimit(h: HeadRuntime, modelMax: number): Promise<void> {
		if (h.modelMax === modelMax) {
			return;
		}
		h.modelMax = modelMax;
		for (const def of ALL_DEFS) {
			const max = this.effectiveMax(def, h);
			if (def.modelLimited && max !== undefined) {
				await this.extendObject(`heads.${h.index}.${def.id}`, { common: { max } });
			}
		}
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
			// The binding is gone with the writes above, so the record goes with it.
			await this.setMeterBoundByAdapter(false);
		} else if (this.controlMode === 'device') {
			const h = this.heads[0];
			if (!h || !this.meterMd) {
				return; // misconfigured — already warned, leave the device alone
			}
			this.meterMdPending = !(await this.writeHead(h, { MM: 1, MD: this.meterMd }, reason));
			await this.setMeterBoundByAdapter(true);
		} else if (!this.controlModeForced && (await this.isMeterBoundByAdapter())) {
			// Off mode releases a binding THIS adapter established in device mode, and only
			// that one: a binding the owner made in the app is theirs and stays. A mode the
			// adapter forced to off is excluded — see controlModeForced.
			const h = this.heads[0];
			if (h && (await this.writeHead(h, { MM: 0, MD: '' }, 'off-cleanup'))) {
				await this.setMeterBoundByAdapter(false);
				this.log.info('Releasing the adapter-managed meter binding (control mode is now off).');
			}
		}
	}

	/**
	 * Writes a payload to one head, logging the outcome without aborting the others.
	 *
	 * @param h the target head
	 * @param payload device fields to write
	 * @param reason context shown in the log line
	 */
	private async writeHead(
		h: HeadRuntime,
		payload: Record<string, string | number>,
		reason: string,
	): Promise<boolean> {
		if (this.stopping) {
			// The shutdown owns the devices from here on; a mode write arriving behind it
			// would undo what the neutralisation just established.
			return false;
		}
		try {
			await h.api.write(payload);
			if (this.controlMode !== 'off') {
				this.log.info(
					`Head ${h.index}: enforced ${this.controlMode} mode (${reason}): ${JSON.stringify(payload)}.`,
				);
			}
			return true;
		} catch (e) {
			this.log.warn(`Head ${h.index}: could not apply ${this.controlMode} mode: ${errMsg(e)}`);
			return false;
		}
	}

	/** Whether the adapter currently holds a device-native meter binding it created. */
	private async isMeterBoundByAdapter(): Promise<boolean> {
		const st = await this.getStateAsync('info.meterBound');
		return !!st?.val;
	}

	/**
	 * Persists whether the adapter holds a meter binding (device mode).
	 *
	 * Survives restarts, but unlike info.gsOwned it needs no retry of its own: a release
	 * that did not land leaves the flag set, and the next start runs enforceMode again.
	 *
	 * @param bound true while the adapter-created binding is active on the device
	 */
	private async setMeterBoundByAdapter(bound: boolean): Promise<void> {
		await this.setState('info.meterBound', { val: bound, ack: true });
	}

	/**
	 * Whether the adapter left a grid setpoint on the heads that nothing is watching.
	 *
	 * Survives restarts on purpose. A head executes its last GS until something says
	 * otherwise — there is no device-side timeout — so an adapter that set one has to
	 * remember that fact even across a crash, a power cut or a switch to another
	 * control mode. This mirrors info.meterBound, which does the same for the far less
	 * dangerous meter binding.
	 */
	private async isGsOwnedByAdapter(): Promise<boolean> {
		const st = await this.getStateAsync('info.gsOwned');
		return !!st?.val;
	}

	/**
	 * Records whether a setpoint of ours is standing on the heads.
	 *
	 * @param owned true once a setpoint has been (or is about to be) written
	 */
	private async setGsOwnedByAdapter(owned: boolean): Promise<void> {
		await this.setState('info.gsOwned', { val: owned, ack: true });
	}

	/**
	 * Reads a JSON host list written by this adapter.
	 *
	 * @param id the state holding the list
	 * @param fallback what to assume when the record is missing or unreadable
	 */
	private async readHostList(id: string, fallback: string[]): Promise<string[]> {
		const st = await this.getStateAsync(id);
		const raw = typeof st?.val === 'string' ? st.val : '';
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string') && parsed.length) {
					return parsed;
				}
			} catch {
				// Not debug: this is a record of hardware the adapter may still be holding,
				// and falling back to the current configuration can mean writing to the
				// wrong device or to none at all. The operator has to be able to see it.
				this.log.warn(`${id} is not valid JSON (${raw}) — falling back to the currently configured heads.`);
			}
		}
		return fallback;
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
			return; // off never writes
		}
		if (this.controlMode === 'device' && (h.index !== 1 || !this.meterMd)) {
			return;
		}
		// A pending binding change is tracked separately: the device reports MM=1 and
		// MS=1 for the binding it already had, so neither of those tells us whether the
		// *new* MD took effect. Only an accepted write does.
		if (this.controlMode === 'device' && this.meterMdPending) {
			if (await this.writeHead(h, { MM: 1, MD: this.meterMd }, 'meter-binding retry')) {
				this.meterMdPending = false;
			}
			return;
		}
		const want = this.controlMode === 'controller' ? 0 : 1;
		const mm = num(data.MM);
		if (mm === undefined || mm === want) {
			this.mmGuardWarned.set(h.index, false);
			// MM alone does not prove the binding works, and MD is documented as not echoing
			// back reliably — the meter status is the only trustworthy confirmation.
			if (this.controlMode === 'device' && mm === 1) {
				await this.guardMeterStatus(h, data);
			}
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

	/**
	 * Confirms a device-mode binding through the reported meter status (MS) and
	 * re-sends MD when the device says it has no meter bound.
	 *
	 * MS values per the vendor API: 0 = no meter bound, 1 = online, 2 = offline,
	 * 3 = requesting IP. Only 0 indicates a binding that never took effect; 2 and 3 are
	 * transient states of an existing binding and are left alone.
	 *
	 * @param h the polled head
	 * @param data its latest reported state
	 */
	private async guardMeterStatus(h: HeadRuntime, data: ReportedState): Promise<void> {
		const ms = num(data.MS);
		if (ms !== 0) {
			this.msGuardWarned.set(h.index, false);
			return;
		}
		if (!this.msGuardWarned.get(h.index)) {
			this.msGuardWarned.set(h.index, true);
			this.log.warn(
				`Head ${h.index}: MM=1 but the device reports no meter bound (MS=0) — the meter connection ` +
					'string did not take effect. Re-sending it.',
			);
		}
		await this.writeHead(h, { MM: 1, MD: this.meterMd }, 'meter-status-guard');
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			return;
		}
		// Foreign grid-power source: only trust acknowledged sensor values (a manually
		// written ack=false test value must not drive the battery).
		if (this.controller && id === this.gridStateId) {
			if (state.ack) {
				// Number(null) and Number('') are 0 and pass isFinite, so a cleared source state
				// would be regulated on as a real "0 W grid". Rejecting here also ages the
				// watchdog, which an unusable value must do.
				const raw = state.val;
				if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
					if (!this.gridValueWarned) {
						this.gridValueWarned = true;
						this.log.warn(
							`Grid source "${id}" delivered a non-numeric value (${JSON.stringify(raw)}) — ignoring it. ` +
								'The controller needs a number in watts.',
						);
					}
					return;
				}
				// The sample’s own timestamp: readings taken before the last write describe the
				// state before it. Not awaited, so a slow device does not hold up the handler — but
				// the rejection is caught, because an unhandled one takes the process down.
				void this.controller.onGridPower(Number(raw), state.ts || Date.now()).catch(e => {
					this.log.error(`Control cycle failed: ${errMsg(e)}`);
				});
			} else if (!this.gridAckWarned) {
				// Silently dropping every value would leave the controller idle at GS=0
				// with no trace at all — name the state and the fix once.
				this.gridAckWarned = true;
				this.log.warn(
					`Grid source "${id}" is written with ack=false — such values are ignored, so the controller ` +
						'never regulates. Point it at the sensor state of the meter adapter, or make the writing ' +
						'script acknowledge its value (setState(id, value, true)).',
				);
			}
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
		if (def.field === 'LM' && !state.val && this.controlMode !== 'off') {
			// LM=0 turns local mode off, which is how the adapter reaches the device at
			// all. Doing that while a control mode is active would strand whatever
			// setpoint is currently standing, with no way left to clear it.
			this.log.warn(
				`Head ${h.index}: refusing to disable local mode (LM) while control mode is ` +
					`"${this.controlMode}" — the adapter would lose access while a setpoint is active. ` +
					'Set the control mode to off first.',
			);
			return;
		}
		if (def.field === 'IS' && this.controller && this.config.controllerControlIs) {
			// Same reasoning as GS: with the IS option on, the controller recomputes the
			// limit every cycle, so a manual value would be silently overwritten within
			// seconds and desync the controller's record of it.
			this.log.warn(
				`Head ${h.index}: ignoring manual IS write — the controller steers IS while "Also steer the ` +
					'inverter limit" is enabled. Turn that option off for manual IS control.',
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
		} else if (def.type === 'boolean') {
			// Switch states are boolean in ioBroker; the device expects 0/1.
			payload = { [def.field]: state.val ? 1 : 0 };
		} else if (def.type === 'string') {
			payload = { [def.field]: state.val == null ? '' : String(state.val) };
		} else {
			const n = roundTo(state.val, 0);
			if (n === null) {
				this.log.warn(`Ignoring invalid value for ${relId}: ${state.val}`);
				return;
			}
			// The device is not obliged to sanity-check what it is sent, and a typo in a
			// script (GS=99999, SI=150) would otherwise go straight to the hardware.
			const max = this.effectiveMax(def, h);
			if ((def.min !== undefined && n < def.min) || (max !== undefined && n > max)) {
				this.log.warn(
					`Ignoring out-of-range value for ${relId}: ${n} (allowed ${def.min ?? '-∞'}…${max ?? '∞'}).`,
				);
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
		const msg = (obj.message ?? {}) as { heads?: unknown };
		const heads: { host?: unknown; label?: unknown }[] = Array.isArray(msg.heads)
			? msg.heads.filter((h): h is { host?: unknown; label?: unknown } => !!h && typeof h === 'object')
			: [];
		// sendTo payloads come from outside this code; a host that is not a string would
		// otherwise reach .trim() and throw out of the message handler.
		const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
		const timeoutMs = Math.max(1000, Math.round(cfgNum(this.config.requestTimeout, 8000)));
		const lines: string[] = [];
		let failures = 0;
		let i = 0;
		for (const h of heads) {
			i++;
			const host = str(h?.host);
			const name = str(h?.label) || `Head ${i}`;
			if (!host) {
				continue; // empty optional slot
			}
			const api = new SunEnergyXtApi(host, timeoutMs, this);
			try {
				const { reported } = await api.read();
				const model = asString(reported.DevType) || 'SunEnergyXT';
				const soc = num(reported.SC);
				lines.push(`• ${name} (${host}): OK — ${model}${soc !== undefined ? `, SoC ${soc}%` : ''}`);
			} catch (e) {
				failures++;
				lines.push(`• ${name} (${host}): unreachable — ${errMsg(e)}`);
			} finally {
				api.destroy();
			}
		}
		const text = lines.length ? lines.join('\n') : 'No head configured to test.';
		const response = failures > 0 || !lines.length ? { error: text } : { result: text };
		if (obj.callback) {
			this.sendTo(obj.from, obj.command, response, obj.callback);
		}
	}

	private onUnload(callback: () => void): void {
		// Set before the first await: a poll already in flight resumes after the unload
		// callback and would write to a device we have just let go of.
		this.stopping = true;
		void (async () => {
			try {
				for (const timer of this.pollTimers.values()) {
					this.clearTimeout(timer);
				}
				this.pollTimers.clear();
				if (this.controller) {
					this.controller.stop();
					// Without this the heads keep executing the last setpoint forever, unwatched. Best
					// effort within a short budget, on a plain timer: ioBroker sets its shutdown flag
					// before calling unload, so the adapter-managed one would never fire — leaving this
					// race with no time limit exactly when it needs one.
					let budget: NodeJS.Timeout | undefined;
					const cleared = await Promise.race([
						this.neutralizeAllGs(),
						new Promise<boolean>(resolve => {
							budget = setTimeout(() => resolve(false), UNLOAD_NEUTRALIZE_BUDGET_MS);
						}),
					]);
					clearTimeout(budget);
					// Only drop ownership when every head confirmed. If the budget ran out
					// or a head refused, the flag stays set and the next start finishes the
					// job — see resumeGsOwnership().
					if (cleared) {
						await this.setGsOwnedByAdapter(false);
					} else {
						this.log.warn(
							'Could not confirm GS=0 on every head within the shutdown budget — the next start ' +
								'will neutralise them again.',
						);
					}
				}
			} catch {
				// ignore — we must always call the callback
			} finally {
				// Leave no socket behind on the heads: their ESP32 has a very small
				// socket table and would only reclaim ours after its own timeout.
				for (const h of this.heads) {
					h.api.destroy();
				}
				callback();
			}
		})();
	}

	/**
	 * The payload that neutralises one head, with the inverter limit handed back whenever
	 * this adapter is the one holding it.
	 *
	 * The limit released is the device maximum, not the head's export cap: MG caps
	 * feed-in, while IS also covers the load port, so releasing to MG would leave a head
	 * whose owner capped feed-in throttled with nobody left to raise it again.
	 */
	private neutralPayload(): { payload: Record<string, number>; releaseIs: boolean } {
		const releaseIs = !!this.config.controllerControlIs;
		return {
			releaseIs,
			payload: releaseIs ? { GS: 0, IS: DEVICE_MAX_W } : { GS: 0 },
		};
	}

	/**
	 * Writes a neutral GS=0 to every reachable head (used during unload). When the
	 * controller also steered IS, that limit is handed back to the head's maximum in
	 * the same request — a stopped adapter must not leave the inverter throttled at a
	 * value nobody maintains any more.
	 *
	 * @param reason context shown in the log line
	 * @returns true only if every head confirmed the write
	 */
	private async neutralizeAllGs(reason = 'controller shutdown'): Promise<boolean> {
		// Every configured head, not just the ones the poll calls online: a head is marked
		// offline after one missed poll while still executing its last setpoint, and those
		// need the write most. In parallel, so trying them all costs no extra time.
		const results = await Promise.all(
			this.heads.map(async h => {
				const { payload, releaseIs } = this.neutralPayload();
				try {
					await h.api.write(payload);
					this.log.info(
						`Head ${h.index}: GS neutralized to 0${releaseIs ? ', IS released to maximum' : ''} (${reason}).`,
					);
					return true;
				} catch (e) {
					this.log.warn(`Head ${h.index}: could not neutralize GS: ${errMsg(e)}`);
					return false;
				}
			}),
		);
		return results.every(Boolean);
	}

	/**
	 * Clears a setpoint an earlier run left on the heads.
	 *
	 * Runs on every start that does *not* enter controller mode. The heads have no
	 * setpoint timeout of their own: whatever GS was last written keeps being executed,
	 * so a crash, a power cut or a switch to off/device mode would otherwise leave a
	 * head charging or discharging at full power with nothing watching it.
	 *
	 * Heads that cannot be reached right now are retried from the poll loop, so the
	 * ownership flag only clears once every head has actually confirmed.
	 */
	private async resumeGsOwnership(): Promise<void> {
		if (!(await this.isGsOwnedByAdapter())) {
			return;
		}
		const hosts = this.heads.map(h => h.host);
		this.log.info(
			`A grid setpoint from an earlier run may still be active on ${hosts.length} head(s) — neutralising them.`,
		);
		const results = await Promise.all(
			hosts.map(async host => {
				const api = this.heads.find(x => hostKey(x.host) === hostKey(host))!.api;
				// GS only: this runs before the first poll, so no head's real maximum is
				// known yet, and 2400 would be handed to a model that may be an 800.
				try {
					await api.write({ GS: 0 });
					this.log.info(`Head ${host}: GS neutralized to 0 (ownership cleanup).`);
					this.gsCleanupDone.add(hostKey(host));
					return true;
				} catch (e) {
					this.log.warn(`Head ${host}: ownership cleanup failed: ${errMsg(e)}`);
					return false;
				}
			}),
		);
		if (results.every(Boolean)) {
			await this.setGsOwnedByAdapter(false);
		} else {
			// Left set on purpose: the poll loop keeps trying as heads come back.
			this.gsCleanupPending = true;
			this.gsCleanupHosts = hosts;
			this.log.warn('Not every head could be neutralised yet — retrying as they answer.');
		}
	}

	/**
	 * Retries the ownership cleanup for one head that has just answered a poll.
	 *
	 * @param h the head that just delivered a successful poll
	 */
	/**
	 * Retries releasing meter bindings on hosts that have no poll of their own.
	 *
	 * A device head 1 no longer points at is never polled, so the off-mode guard never
	 * reaches it while it keeps regulating itself from the meter this adapter bound.
	 * Rides along on any other head's poll, on its own throttle.
	 */
	/** Clears the ownership flag once every host of the outstanding job is done. */
	private async finishCleanupIfDone(): Promise<void> {
		if (this.gsCleanupHosts.every(host => this.gsCleanupDone.has(hostKey(host)))) {
			this.gsCleanupPending = false;
			await this.setGsOwnedByAdapter(false);
			this.log.info('All heads neutralised — the adapter no longer holds a grid setpoint.');
		}
	}

	private async retryGsCleanup(h: HeadRuntime): Promise<void> {
		if (this.stopping) {
			return;
		}
		if (
			!this.gsCleanupPending ||
			this.controlMode === 'controller' ||
			this.gsCleanupDone.has(hostKey(h.host)) ||
			// Only heads that are actually part of the outstanding job. Without this a
			// head that was never on the list gets neutralised just because it happens to
			// be polling, while the heads the job is about are never reached.
			!this.gsCleanupHosts.some(x => hostKey(x) === hostKey(h.host))
		) {
			return;
		}
		try {
			// IS goes in the same request, or a head cleaned up here keeps a throttled limit
			// that nothing will lift.
			const { payload, releaseIs } = this.neutralPayload();
			await h.api.write(payload);
			this.log.info(
				`Head ${h.index}: GS neutralized to 0${releaseIs ? ', IS released to maximum' : ''} (ownership cleanup, retry).`,
			);
			this.gsCleanupDone.add(hostKey(h.host));
			// Measured against the hosts the *previous* run recorded, not the current
			// configuration: a head removed in between must not make this look finished.
			await this.finishCleanupIfDone();
		} catch (e) {
			this.log.debug(`Head ${h.index}: ownership cleanup retry failed: ${errMsg(e)}`);
		}
	}

	/**
	 * Starts the multi-head self-consumption controller (controller mode).
	 *
	 * @param inheritedOwnership true when a previous run may have left setpoints on the
	 * heads, so the controller starts out responsible for them
	 */
	private async setupController(inheritedOwnership = false): Promise<void> {
		this.gridStateId = (this.config.gridPowerStateId || '').trim();
		if (!this.gridStateId) {
			// onReady() already falls back to off in this case; this stays as a guard so
			// the method is safe to call from anywhere.
			this.log.warn(
				'Controller mode selected but no grid-power source state configured — controller not started.',
			);
			return;
		}
		// cfgNum keeps explicit zeros (gain/dead bands of 0 must not become defaults).
		const cfg: ControllerConfig = {
			// Adaptive tiers by default; missing key (pre-0.2.7 installs) means adaptive.
			adaptive: this.config.controllerAdaptive !== false,
			targetW: Math.max(-200, Math.min(200, cfgNum(this.config.controllerTargetW, 0))),
			gain: cfgNum(this.config.controllerGain, 0.3),
			deadBandW: Math.max(0, cfgNum(this.config.controllerDeadBandW, 20)),
			maxStepW: Math.max(0, cfgNum(this.config.controllerMaxStepW, 500)),
			minIntervalMs: Math.max(1000, cfgNum(this.config.controllerMinIntervalMs, 5000)),
			writeDeadBandW: Math.max(0, cfgNum(this.config.controllerWriteDeadBandW, 10)),
			meterStabilizationMs: Math.max(0, cfgNum(this.config.controllerMeterStabilizationMs, 0)),
			controlIs: !!this.config.controllerControlIs,
			isWriteDeadBandW: Math.max(1, cfgNum(this.config.controllerIsWriteDeadBandW, 10)),
			inverted: !!this.config.gridPowerInverted,
			warnSec: Math.max(5, cfgNum(this.config.watchdogWarnSec, 30)),
			failsafeSec: Math.max(10, cfgNum(this.config.watchdogFailsafeSec, 180)),
		};
		const hooks: ControllerHooks = {
			getHeads: () => this.headStates(),
			writeGs: async (index, gs) => {
				const h = this.heads.find(x => x.index === index);
				if (h) {
					await h.api.write({ GS: gs }, CONTROL_WRITE_TIMEOUT_MS);
				}
			},
			reflectGs: async (index, gs) => {
				const id = `heads.${index}.control.GS`;
				await this.setStateChangedAsync(id, gs, true);
				// Keep the confirm cache in sync so the next poll does not re-write it.
				this.confirmedCache.set(id, gs);
			},
			writeIs: async (index, is) => {
				const h = this.heads.find(x => x.index === index);
				if (h) {
					await h.api.write({ IS: is }, CONTROL_WRITE_TIMEOUT_MS);
				}
			},
			reflectIs: async (index, is) => {
				const id = `heads.${index}.control.IS`;
				await this.setStateChangedAsync(id, is, true);
				this.confirmedCache.set(id, is);
			},
		};
		this.controller = new MultiHeadController(this, hooks, this.gridStateId, cfg);
		await this.subscribeForeignStatesAsync(this.gridStateId);
		// Inherited before the first write: the controller only knows what it wrote itself,
		// so a head whose initial GS=0 fails would otherwise look untouched.
		if (inheritedOwnership) {
			this.controller.assumeCommanded(this.heads.map(h => h.index));
		}
		// Claim ownership *before* the first setpoint leaves: if the process dies between
		// the write and the flag, the next start must still know a setpoint is standing.
		await this.setGsOwnedByAdapter(true);
		await this.controller.start();
		this.log.info(
			`Self-consumption controller active on grid source "${this.gridStateId}" across ${this.heads.length} head(s).`,
		);
	}

	/** Maps the current head runtime to the pure HeadState used by the controller and split. */
	private headStates(): HeadState[] {
		return this.heads.map(h => ({
			index: h.index,
			// Deliberately not h.online: that flips on the first missed poll, while a head
			// stays a live participant in the grid until several polls in a row have
			// failed. See CONTROL_DROP_AFTER_FAILURES.
			online: h.online || h.pollFailures < CONTROL_DROP_AFTER_FAILURES,
			gp: h.gp ?? 0,
			// A head that answered without SoC must not be regulated on placeholders. socMin
			// included: substituting 0 would invent a floor the device never agreed to.
			controllable: h.soc !== undefined && h.socMax !== undefined && h.socMin !== undefined,
			soc: h.soc ?? 0,
			socMin: h.socMin ?? 0,
			socMax: h.socMax ?? 100,
			maxPower: h.maxPower,
			// MG caps the output only. Drawing is documented as -2400..0 for both models,
			// and IS as 1..2400 — the vendor's own integration lowers neither for a 500.
			maxCharge: DEVICE_MAX_W,
			maxInverter: DEVICE_MAX_W,
			lp: h.lp ?? 0,
			pv: h.pv ?? 0,
			// 5 % is the manufacturer default; assuming none would reintroduce the chatter.
			socHysteresisDischarge: h.socHysteresisDischarge ?? 5,
			socHysteresisCharge: h.socHysteresisCharge ?? 5,
		}));
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Sunenergyxt500(options);
} else {
	// otherwise start the instance directly
	(() => new Sunenergyxt500())();
}
