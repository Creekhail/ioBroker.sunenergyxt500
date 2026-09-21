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
 * Meter samples older than the last write are dropped (see sampleIsFresh): they still
 * describe the pre-write state, so regulating on them would apply the same correction
 * twice and make the loop hunt. Writes to different heads go out concurrently, so one
 * slow head cannot push the cycle past its tier interval.
 *
 * With `controlIs` the loop additionally sets each head's inverter output limit IS to
 * match the GS it just commanded (see computeIsTarget). That limit is released back to
 * the head's maximum on failsafe and on shutdown — nothing else maintains it once the
 * controller stops regulating.
 *
 * Sign convention of the source state: > 0 = grid draw, < 0 = feed-in (Shelly).
 * If the configured meter uses the opposite convention, enable `inverted`.
 *
 * Watchdog: if the source state goes stale (sensor/network dead) the setpoints would
 * otherwise freeze. Two stages:
 *   - from warnSec:     log + telemetry only
 *   - from failsafeSec: GS = 0 on every head (safe neutral) until the source recovers
 * The same failsafeSec budget applies when no value ever arrived (wrong state id, or
 * a source writing with ack=false): controller mode has switched the device's own
 * regulation off, so a silently idle loop means nothing regulates at all.
 */

import type { HeadState } from './split';
import { computeIsTarget, computeTotalTarget, inChargeBand, inDischargeBand, splitTarget } from './split';
import type { LocalizedName } from './states';

/** One regulation tier of the adaptive mode. */
export interface AdaptiveTier {
	/** This tier applies while the absolute grid error is below this bound (W). */
	maxErrorW: number;
	/** Minimum time between two corrections in this tier (ms). */
	intervalMs: number;
	/** Maximum setpoint movement per correction in this tier (W). */
	maxStepW: number;
}

/**
 * Fixed tiers of the adaptive mode — the manufacturer-proven values from the
 * official zero-feed-in blueprint: react gently to small deviations, promptly to
 * medium ones and immediately (with a large step) to real load changes.
 */
export const ADAPTIVE_TIERS: AdaptiveTier[] = [
	{ maxErrorW: 30, intervalMs: 7000, maxStepW: 20 },
	{ maxErrorW: 150, intervalMs: 2500, maxStepW: 120 },
	{ maxErrorW: Number.POSITIVE_INFINITY, intervalMs: 1000, maxStepW: 450 },
];

/** Fixed dead band of the adaptive mode (W): errors below it are left alone. */
export const ADAPTIVE_DEAD_BAND_W = 5;

/**
 * Picks the adaptive tier for an absolute grid error.
 *
 * @param errorAbsW absolute deviation from the target grid power in W
 */
export function adaptiveTierFor(errorAbsW: number): AdaptiveTier {
	return ADAPTIVE_TIERS.find(t => errorAbsW < t.maxErrorW) ?? ADAPTIVE_TIERS[ADAPTIVE_TIERS.length - 1];
}

/** Tuning parameters of the self-consumption controller. */
export interface ControllerConfig {
	/**
	 * Adaptive mode: regulate in the fixed ADAPTIVE_TIERS (gain 1, per-tier interval
	 * and step limit, fixed dead band). When false, the manual gain/deadBandW/
	 * minIntervalMs/maxStepW settings below apply instead.
	 */
	adaptive: boolean;
	/**
	 * Target grid power in W (source-state convention: >0 = deliberate grid draw,
	 * <0 = deliberate feed-in). 0 = classic zero feed-in.
	 */
	targetW: number;
	/** Proportional gain: fraction of the grid deviation corrected per step. */
	gain: number;
	/** Grid dead band in W — deviations below it are not corrected. */
	deadBandW: number;
	/** Maximum movement of the total setpoint per correction step in W; 0 = unlimited. */
	maxStepW: number;
	/** Minimum time between two write cycles in ms. */
	minIntervalMs: number;
	/** Minimum change of a head's setpoint before it is re-written (anti-chatter). */
	writeDeadBandW: number;
	/**
	 * Extra settling time in ms granted to a slow meter on top of the sample-freshness
	 * check: a sample must be newer than the last write *plus* this delay before it is
	 * used. 0 suits meters whose reading follows the physical change immediately; raise
	 * it slightly above the observed content delay for meters that keep publishing fresh
	 * timestamps while the value still describes the state before the last write.
	 */
	meterStabilizationMs: number;
	/**
	 * Also steer the inverter output limit IS alongside GS. Off by default: IS normally
	 * sits at the device maximum, and moving it is a change users should opt into.
	 * When enabled the controller restores IS to the head's maximum on failsafe and on
	 * shutdown, so a stopped adapter never leaves the inverter throttled.
	 */
	controlIs: boolean;
	/** Minimum change of a head's IS before it is re-written (anti-chatter, W). */
	isWriteDeadBandW: number;
	/** Invert the sign of the grid-power source (meters using >0 = feed-in). */
	inverted: boolean;
	/** Watchdog: log a warning after this many seconds without a source update. */
	warnSec: number;
	/** Watchdog: force GS=0 after this many seconds without a source update. */
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
	/** Writes an IS limit (W) to the head with the given 1-based index. */
	writeIs(index: number, is: number): Promise<void>;
	/** Mirrors the commanded IS onto heads.<index>.control.IS. */
	reflectIs(index: number, is: number): Promise<void>;
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
		id: 'controller.gridPower',
		type: 'number',
		role: 'value.power',
		unit: 'W',
		name: {
			en: 'House grid power as seen by the controller (+draw / −feed-in)',
			de: 'Hausanschluss-Netzleistung wie vom Regler gesehen (+Bezug / −Einspeisung)',
		},
	},
	{
		id: 'controller.totalTarget',
		type: 'number',
		role: 'value.power',
		unit: 'W',
		name: {
			en: 'Total grid setpoint before the split (+discharge / −charge)',
			de: 'Gesamt-Sollwert vor der Aufteilung (+entladen / −laden)',
		},
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

/**
 * Upper bound for the sample-freshness gate (ms). The gate discards meter samples that
 * still describe the state before the last write; if the source's clock runs behind the
 * adapter's, every sample would look stale and the loop would never regulate again. This
 * bound ends that: once the last write is this old, the next sample is used whatever its
 * timestamp says. Regulating on a slightly stale reading is recoverable, freezing the
 * setpoints is not.
 */
const STALE_SAMPLE_OVERRIDE_MS = 30000;

/**
 * Minimum gap between two write-failure warnings for the same head (ms). A head on a
 * weak Wi-Fi link fails on every cycle; logging each attempt buries everything else.
 * The first failure and the recovery are always logged, the repetitions are summarised.
 */
const WRITE_FAILURE_LOG_INTERVAL_MS = 60000;

/**
 * A polled GS echo deviating from the commanded value by more than this (W) means
 * somebody else wrote GS — the vendor app, or a second automation. Rounding alone
 * cannot produce this much, since the device echoes GS exactly.
 */
const FOREIGN_GS_DEVIATION_W = 5;

/** Minimum gap between two foreign-GS warnings for the same head (ms). */
const FOREIGN_GS_LOG_INTERVAL_MS = 300000;

/**
 * Back-off before retrying an IS write for a head whose last one failed (ms).
 *
 * Deliberately a constant rather than a tuning parameter: this is failure throttling,
 * not regulation. A successful IS write is never held back.
 */
const IS_RETRY_AFTER_FAILURE_MS = 10000;

/**
 * Back-off between IS release attempts (ms). Shorter than the normal failure back-off
 * because handing the limit back matters more than a regular adjustment, but not zero:
 * an unreachable head would otherwise add a request per source value.
 */
const IS_RELEASE_RETRY_MS = 5000;

/** Back-off between neutralisation attempts for a head that cannot be regulated (ms). */
const UNCONTROLLABLE_RETRY_MS = 10000;

/** One self-consumption control loop steering the grid setpoint of 1–3 heads. */
export class MultiHeadController {
	/**
	 * When the last write cycle *started*. Drives the tier interval: the rate limit is
	 * about how often the controller reaches for the device, so it counts attempts.
	 */
	private lastWriteTime = 0;
	/**
	 * When the last write cycle *finished*. Drives the sample-freshness gate, which is
	 * about physics: a reading only reflects a new setpoint once that setpoint actually
	 * reached the device. A write can sit queued behind a poll for seconds, so dating
	 * the gate from the attempt would let readings taken during that wait through.
	 */
	private lastWriteDoneTs = 0;
	/** Last total setpoint actually dispatched, used to detect a real aggregate move. */
	private lastTotalTarget = 0;
	/**
	 * What we last successfully commanded each head — the adapter's record of the
	 * device's actual setpoint. Safety decisions (failsafe neutralisation, the GS echo
	 * comparison, the write dead band) read this and nothing else.
	 */
	private readonly lastGs = new Map<number, number>();
	/**
	 * Feed-forward base per head. Starts out equal to the commanded GS but is corrected
	 * by the anti-windup sync when a device visibly does not follow it. Kept separate
	 * from `lastGs`: adopting a measured value into the command record would make the
	 * failsafe believe a head is already neutral when it is not.
	 */
	private readonly ffBase = new Map<number, number>();
	private readonly lastIs = new Map<number, number>();
	private writeInProgress = false;
	private everSeenSource = false;
	/** Failsafe because the grid source is silent. Cleared by any usable sample. */
	private failsafeActive = false;
	/**
	 * Failsafe because no head can be regulated. Deliberately separate from
	 * `failsafeActive`: that one is about the *source* and is rightly cleared by every
	 * usable sample, while this one is about the *heads* and a fresh meter reading says
	 * nothing about them. Sharing one flag made a healthy meter clear the head failsafe
	 * on every sample, so status and log flipped once per reading.
	 */
	private headFailsafeActive = false;
	private warnLogged = false;
	private maxGapSec = 0;
	private watchdogTimer?: ioBroker.Interval;
	/** Start time, used to age out a source that never delivered a single value. */
	private startedAt = 0;
	/** Set by stop(); every write path checks it so nothing escapes after shutdown. */
	private stopped = false;
	/**
	 * Timestamp of the last sample the loop could actually use. The watchdog runs on
	 * this rather than on the raw state's `ts`: a source that keeps publishing values
	 * the loop rejects — written with ack=false, or non-numeric — would otherwise look
	 * perfectly healthy while nothing is regulating at all.
	 */
	private lastValidSampleTs = 0;
	/** Per-head write-failure bookkeeping, used to debounce the warning. */
	private readonly writeFailures = new Map<number, { count: number; lastLog: number }>();
	/** Per-head timestamp of the last *failed* IS write; drives the retry back-off. */
	private readonly lastIsFailure = new Map<number, number>();
	/** Per-head timestamp of the last IS release attempt, so a failing one is throttled. */
	private readonly lastIsRelease = new Map<number, number>();
	/** IS write-failure bookkeeping, kept apart from the GS one (see writeHeadIs). */
	private readonly isWriteFailures = new Map<number, { count: number; lastLog: number }>();
	/** Per-head timestamp of the last foreign-GS warning, used to debounce it. */
	private readonly lastForeignGsLog = new Map<number, number>();
	/** Per-head start of an episode without usable SoC data, used to warn once per episode. */
	private readonly notControllableSince = new Map<number, number>();
	/** Per-head timestamp of the last neutralisation attempt for an uncontrollable head. */
	private readonly lastUncontrollableTry = new Map<number, number>();
	/** Start of the current episode without any regulatable head; 0 when there is one. */
	private noControllableSince = 0;
	/**
	 * Heads held out by the *discharge* floor, and those held out by the *charge*
	 * ceiling, kept apart.
	 *
	 * One shared set loses the information: a head that hit its discharge floor and is
	 * then charged for a moment has its record cleared by that charge, so the discharge
	 * hysteresis no longer applies and the loop commands power the device still refuses.
	 * The two limits are independent, so their memories have to be too.
	 */
	private readonly saturatedDischarge = new Set<number>();
	private readonly saturatedCharge = new Set<number>();
	/**
	 * Heads whose SoC this controller has already evaluated at least once.
	 *
	 * The saturation memory above records what *this* run observed. After a restart —
	 * or after forgetHead() dropped a head that went away and came back — it is empty,
	 * so a head whose charge sits inside the device's hysteresis band looks free to
	 * use. It is not: the device refuses until the band is cleared. See seedSaturation().
	 */
	private readonly socEvaluated = new Set<number>();
	/**
	 * Heads this controller has ever commanded. Survives forgetHead(), which drops the
	 * per-head setpoint record: without it a head that went offline and came back would
	 * look like one we never touched, and an old setpoint on it would be left alone.
	 */
	private readonly everCommanded = new Set<number>();
	/** Consecutive cycles that only ran because of the stale-sample override. */
	private overrideStreak = 0;

	/**
	 * @param adapter the adapter instance (logging, states, timers)
	 * @param hooks head snapshot and GS write callbacks provided by the adapter
	 * @param gridStateId foreign state id of the grid-power source (watchdog checks its age)
	 * @param cfg controller tuning parameters
	 */
	public constructor(
		private readonly adapter: ioBroker.Adapter,
		private readonly hooks: ControllerHooks,
		private readonly gridStateId: string,
		private readonly cfg: ControllerConfig,
	) {}

	/** Sets every head to a neutral GS=0 and starts the watchdog. */
	public async start(): Promise<void> {
		this.startedAt = Date.now();
		await this.writeAll(0);
		await this.publishStatus();
		this.adapter.log.info('Multi-head controller started — all heads GS=0.');
		this.watchdogTimer = this.adapter.setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
	}

	/**
	 * Stops the watchdog and blocks any further regulation from this instance.
	 *
	 * The flag matters as much as the timer: no new cycle starts, and the IS block that
	 * runs after the GS writes is skipped. GS writes of a cycle all start in the same
	 * tick, so a stop cannot land between them; a request already handed to a head
	 * cannot be recalled either — that one is bounded by the HTTP deadline, and the
	 * shutdown neutralisation that follows overwrites its effect.
	 */
	public stop(): void {
		this.stopped = true;
		if (this.watchdogTimer) {
			this.adapter.clearInterval(this.watchdogTimer);
			this.watchdogTimer = undefined;
		}
	}

	/**
	 * Handle a new value of the configured grid-power source state.
	 *
	 * @param value raw source value
	 * @param ts timestamp of the sample (ms); defaults to now for callers without one
	 */
	public async onGridPower(value: number, ts = Date.now()): Promise<void> {
		if (this.stopped || !Number.isFinite(value)) {
			return;
		}
		this.everSeenSource = true;
		// Guard against a clock-skewed source dating its samples into the future, which
		// would otherwise keep the watchdog happy indefinitely.
		this.lastValidSampleTs = Math.min(Math.max(this.lastValidSampleTs, ts), Date.now());
		if (this.failsafeActive || this.warnLogged) {
			if (this.failsafeActive) {
				this.adapter.log.info('Grid source is delivering — controller active.');
			}
			this.failsafeActive = false;
			this.warnLogged = false;
			if (!this.headFailsafeActive) {
				await this.publishStatus();
			}
		}
		const gridPower = this.cfg.inverted ? -value : value;
		// Written for every accepted value, so it also shows that readings arrive while
		// the loop sits in its dead band; a positive reading during a real house export
		// exposes a wrong `inverted`.
		await this.adapter.setStateChangedAsync('controller.gridPower', Math.round(gridPower), true);
		await this.regulate(gridPower, ts);
	}

	/**
	 * Publishes the controller status derived from every condition at once.
	 *
	 * The status had seven writers, each seeing only its own flag — which is how a
	 * source warning could overwrite an active head failsafe and then never be undone.
	 * Deriving it in one place makes the precedence explicit: any failsafe outranks a
	 * warning, and `ok` requires that nothing is wrong at all.
	 */
	private async publishStatus(): Promise<void> {
		const status = this.failsafeActive || this.headFailsafeActive ? 'failsafe' : this.warnLogged ? 'warn' : 'ok';
		await this.adapter.setStateChangedAsync('controller.status', status, true);
	}

	/**
	 * Sample-freshness gate: a meter sample taken before the last write still describes
	 * the state the device was in *before* that write, so regulating on it applies the
	 * same correction twice and makes the loop hunt. Only samples newer than the last
	 * write (plus the configured settling time) are acted upon.
	 *
	 * Deliberately limited to the meter: unlike the manufacturer blueprint we do not
	 * also require a fresh GP sample, because GP does not enter our control law (the
	 * feed-forward base is the commanded GS) and our poll runs at 5-15 s — demanding a
	 * fresh poll would throttle the 1 s tier down to the poll rate for no benefit.
	 *
	 * @param sampleTs timestamp of the meter sample in ms
	 * @param now current time in ms
	 */
	private sampleIsFresh(sampleTs: number, now: number): boolean {
		if (!this.lastWriteDoneTs) {
			return true; // nothing written yet — every sample is usable
		}
		const stale = sampleTs <= this.lastWriteDoneTs + this.cfg.meterStabilizationMs;
		if (!stale) {
			// Decided on the sample, not on how long ago the last write was: a plant sitting
			// at target delivers fresh samples with no write between them.
			this.overrideStreak = 0;
			return true;
		}
		if (now - this.lastWriteDoneTs >= STALE_SAMPLE_OVERRIDE_MS) {
			// If the override is what keeps the loop alive, regulation runs at 1/30 Hz and the
			// operator needs to know. Only overrides count, so the streak stays meaningful at
			// a 1 Hz source.
			if (++this.overrideStreak === 3) {
				this.adapter.log.warn(
					`Grid source "${this.gridStateId}" keeps delivering samples timestamped before the last ` +
						'write. Its clock is probably behind this host — regulation is falling back to one ' +
						`correction per ${STALE_SAMPLE_OVERRIDE_MS / 1000} s.`,
				);
			}
			return true;
		}
		return false;
	}

	/**
	 * Computes the total setpoint, splits it and writes the per-head GS.
	 *
	 * @param gridPower normalized grid power (> 0 = draw)
	 * @param sampleTs timestamp of the meter sample this value came from (ms)
	 */
	private async regulate(gridPower: number, sampleTs: number): Promise<void> {
		if (this.stopped || this.writeInProgress) {
			return;
		}
		// Claimed before the first await, released in the finally below: setting it later
		// leaves the telemetry write as a window for a second event on the same base.
		this.writeInProgress = true;
		try {
			await this.runCycle(gridPower, sampleTs);
		} finally {
			this.writeInProgress = false;
		}
	}

	/**
	 * One regulation cycle, already holding the write lock.
	 *
	 * @param gridPower normalized grid power (> 0 = draw)
	 * @param sampleTs timestamp of the meter sample this value came from (ms)
	 */
	private async runCycle(gridPower: number, sampleTs: number): Promise<void> {
		const error = gridPower - this.cfg.targetW;
		// Effective parameters: adaptive mode picks them per error tier (gain 1),
		// manual mode uses the configured values.
		const tier = this.cfg.adaptive ? adaptiveTierFor(Math.abs(error)) : undefined;
		const minIntervalMs = tier ? tier.intervalMs : this.cfg.minIntervalMs;
		const deadBandW = tier ? ADAPTIVE_DEAD_BAND_W : this.cfg.deadBandW;
		const gain = tier ? 1 : this.cfg.gain;
		const maxStepW = tier ? tier.maxStepW : this.cfg.maxStepW;
		const now = Date.now();
		if (now - this.lastWriteTime < minIntervalMs) {
			return;
		}
		if (!this.sampleIsFresh(sampleTs, now)) {
			return; // sample predates the last write — it cannot show its effect yet
		}
		// Inside the dead band the grid error is left alone, but the cycle still runs: a
		// head may have hit its SoC limit, and IS has to follow a changed load or PV.
		const inDeadBand = Math.abs(error) < deadBandW;
		const all = this.hooks.getHeads();
		// Before narrowing to the regulatable heads: a reachable head that lost its SoC
		// data would otherwise silently keep its last setpoint forever.
		await this.handleUncontrollable(all);
		const heads = all.filter(h => h.online && h.controllable);
		if (!heads.length) {
			await this.reportNoControllableHead(all);
			return;
		}
		if (this.noControllableSince || this.headFailsafeActive) {
			this.noControllableSince = 0;
			if (this.headFailsafeActive) {
				this.headFailsafeActive = false;
				this.adapter.log.info('A head is regulatable again — controller active.');
				await this.publishStatus();
			}
		}
		// Feed-forward base: every head executes its GS, so the setpoints sum to the
		// current grid power without an extra read, and the loop integrates to the target
		// instead of leaving a steady-state error.
		const base = heads.reduce(
			(acc, h) => acc + (this.ffBase.get(h.index) ?? (Number.isFinite(h.gp) ? h.gp : 0)),
			0,
		);
		const sumMax = heads.reduce((acc, h) => acc + Math.abs(h.maxPower), 0);
		let totalTarget = inDeadBand
			? Math.round(Math.max(-sumMax, Math.min(sumMax, base)))
			: computeTotalTarget(base, error, gain, sumMax);
		// Step limit: cap the movement per correction so a meter spike cannot slam
		// the setpoint even with a high gain (manufacturer blueprint does the same).
		if (maxStepW > 0 && !inDeadBand) {
			const lo = Math.max(base - maxStepW, -sumMax);
			const hi = Math.min(base + maxStepW, sumMax);
			totalTarget = Math.round(Math.max(lo, Math.min(hi, totalTarget)));
		}
		// Published before the split so a "controller wants to charge but the heads do
		// not follow" situation is visible without reading the debug log.
		await this.adapter.setStateChangedAsync('controller.totalTarget', totalTarget, true);
		this.seedSaturation(heads);
		const charging = totalTarget < 0;
		const memory = charging ? this.saturatedCharge : this.saturatedDischarge;
		const setpoints = splitTarget(totalTarget, heads, memory);
		// Recorded per direction, and only for heads the split excluded for that reason:
		// deriving it from `gs === 0` would also catch offline heads and rounded-away shares.
		for (const sp of setpoints) {
			if (sp.socLimited) {
				memory.add(sp.index);
			} else if (sp.gs !== 0) {
				memory.delete(sp.index);
			}
		}

		{
			// A head is also due when the *total* moved by at least the dead band: with three
			// heads a 20 W tier step arrives as 6.7 W each, below the 10 W default, and
			// nothing would ever be written.
			const totalMoved = Math.abs(totalTarget - this.lastTotalTarget) >= this.cfg.writeDeadBandW;
			const due = setpoints.filter(sp => {
				const prev = this.lastGs.get(sp.index);
				if (prev === undefined) {
					return true;
				}
				const moved = Math.abs(sp.gs - prev);
				// An unchanged setpoint is never worth a request; with a dead band of 0 the
				// comparison below would call every head due on every cycle.
				if (moved === 0) {
					return false;
				}
				// Going to zero on a SoC limit is a safety action, not an optimisation step, so it
				// reaches the device even below the dead band.
				if (sp.gs === 0 && sp.socLimited) {
					return true;
				}
				return moved >= this.cfg.writeDeadBandW || totalMoved;
			});

			// Concurrent: a slow head must not delay the others, which a sequential loop would
			// cost up to N * timeout. Within one head the write stays ordered before its mirror.
			const results = await Promise.all(due.map(sp => this.writeHeadGs(sp.index, sp.gs)));
			if (this.cfg.controlIs && !this.stopped) {
				// Derived from all setpoints, not only those that moved: a head whose GS stayed put
				// can still need a new limit when its load or PV changed.
				const byIndex = new Map(setpoints.map(sp => [sp.index, sp.gs]));
				await Promise.all(
					heads.map(h => this.writeHeadIs(h.index, computeIsTarget(h, byIndex.get(h.index) ?? 0))),
				);
			}
			if (results.length > 0 && results.every(Boolean)) {
				// Only a fully landed move counts. Recording the intent would make a failed small
				// multi-head step look done, and every per-head delta is below the dead band again
				// on the next cycle, so it is never retried.
				this.lastTotalTarget = totalTarget;
			}
			if (due.length) {
				// Rate limit: the attempt, not the success. A failed write must arm the interval,
				// or a head that times out retries on every source value.
				this.lastWriteTime = now;
				// Freshness gate: the completion. The writes may have queued behind a poll for
				// seconds, and a reading taken during that wait predates them.
				this.lastWriteDoneTs = Date.now();
			}
			if (results.some(Boolean)) {
				this.adapter.log.debug(
					`Total target ${totalTarget} W → ${setpoints.map(s => `H${s.index}:${s.gs}`).join(' ')} (grid ${Math.round(gridPower)} W)`,
				);
			}
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
		const last = this.ffBase.get(index);
		if (last === undefined || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
			return;
		}
		if (Math.abs(gp - last) > SYNC_DEVIATION_W) {
			this.ffBase.set(index, Math.round(gp));
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
	/**
	 * Takes over responsibility for heads a previous run may have left a setpoint on.
	 *
	 * `everCommanded` otherwise only knows what *this* controller object wrote. A run
	 * that inherits `info.gsOwned` and whose initial GS=0 fails on one head would treat
	 * that head as never touched — and if it then stops delivering SoC data, nothing
	 * clears the setpoint it is still executing.
	 *
	 * @param indexes 1-based head numbers that may be carrying an inherited setpoint
	 */
	public assumeCommanded(indexes: number[]): void {
		for (const index of indexes) {
			this.everCommanded.add(index);
		}
	}

	/**
	 * Drops the remembered setpoint of a head (e.g. it went offline and may reboot with
	 * GS=0), so the base falls back to its polled grid power on return.
	 *
	 * @param index 1-based head number
	 */
	public forgetHead(index: number): void {
		this.lastGs.delete(index);
		this.ffBase.delete(index);
		this.lastIs.delete(index);
		this.notControllableSince.delete(index);
		this.saturatedDischarge.delete(index);
		this.saturatedCharge.delete(index);
		// Without this the head would look evaluated but unsaturated — the empty-memory
		// case seedSaturation() exists for.
		this.socEvaluated.delete(index);
	}

	/**
	 * Makes "nothing left to regulate" visible.
	 *
	 * The source watchdog cannot see this: the meter is delivering fine, there is simply
	 * no head able to act on it. Without this the controller would sit at status `ok`
	 * while the house runs unregulated — the same silent standstill the source watchdog
	 * exists to prevent.
	 *
	 * @param all current snapshot of every head
	 */
	private async reportNoControllableHead(all: HeadState[]): Promise<void> {
		if (!all.length) {
			return;
		}
		const now = Date.now();
		if (!this.noControllableSince) {
			this.noControllableSince = now;
			return;
		}
		const sinceSec = (now - this.noControllableSince) / 1000;
		if (sinceSec < this.cfg.failsafeSec || this.headFailsafeActive) {
			return;
		}
		this.headFailsafeActive = true;
		await this.publishStatus();
		this.adapter.log.warn(
			`No head has been regulatable for ${Math.round(sinceSec)} s (offline, or reporting no usable ` +
				'SoC data) — nothing is regulating. Check the heads.',
		);
	}

	/**
	 * Handles a head that is reachable but no longer delivers what the control law needs
	 * (missing SoC or its limits).
	 *
	 * Dropping it from the split is not enough: it keeps executing the setpoint it was
	 * last given, and because the meter source is still healthy the watchdog never
	 * fires. So the head is neutralised — and because the condition may be a single bad
	 * payload, the neutralisation is only triggered once per episode, then retried until
	 * it succeeds.
	 *
	 * @param heads current snapshot of every head
	 */
	private async handleUncontrollable(heads: HeadState[]): Promise<void> {
		for (const h of heads) {
			if (h.online && !h.controllable) {
				// First and unconditionally: hanging it off the GS decision left a throttled limit
				// on any head whose GS was already zero.
				if (this.cfg.controlIs && this.lastIs.get(h.index) !== Math.round(Math.abs(h.maxPower))) {
					await this.writeHeadIs(h.index, Math.round(Math.abs(h.maxPower)), true);
				}
				const commanded = this.lastGs.get(h.index);
				if (commanded === 0) {
					continue; // we know this head is already neutral
				}
				// `undefined` is not zero: forgetHead() drops the record, and an inherited setpoint
				// was never recorded here. Either way, neutralise rather than assume.
				if (commanded === undefined && !this.everCommanded.has(h.index)) {
					continue; // never commanded anything on this head
				}
				// Throttled: this runs inside the cycle lock, so a failing head would otherwise add
				// two requests to every source value and hold the lock for both.
				const lastTry = this.lastUncontrollableTry.get(h.index) ?? 0;
				if (Date.now() - lastTry < UNCONTROLLABLE_RETRY_MS) {
					continue;
				}
				this.lastUncontrollableTry.set(h.index, Date.now());
				if (!this.notControllableSince.has(h.index)) {
					this.notControllableSince.set(h.index, Date.now());
					this.adapter.log.warn(
						// Not "reachable but …": a head stays a control participant for the first few failed
						// polls, so this also fires for one that has not answered yet.
						`Head ${h.index}: no usable SoC data (not answering, or an unexpected payload) — it ` +
							`cannot be regulated, so its setpoint ` +
							`(${commanded === undefined ? 'unknown' : `${commanded} W`}) is being cleared.`,
					);
				}
				await this.writeHeadGs(h.index, 0);
			} else {
				this.notControllableSince.delete(h.index);
				this.lastUncontrollableTry.delete(h.index);
			}
		}
	}

	/**
	 * Assumes a head found inside a SoC hysteresis band is still held there.
	 *
	 * The saturation memory only knows what this run saw. After a restart, or after
	 * forgetHead() dropped a head that came back, it is empty — and a head sitting at,
	 * say, 6 % with a floor of 5 % and a 5 % band then looks free to use. It is not:
	 * the device does not release it until 10 %. The loop commands power, the device
	 * refuses, the anti-windup pulls the base back, and it starts over — around fifty
	 * writes per two minutes for as long as the charge stays in the band, which at a
	 * discharge floor is most of the night.
	 *
	 * Which way a head entered the band cannot be told from the outside: at 6 % it may
	 * be blocked on its way up, or discharging normally on its way down. Assuming it is
	 * blocked is the harmless error — a head that would have worked idles until its
	 * charge leaves the band, and the opposite direction is untouched, so the next time
	 * the plant charges it is free again. Assuming it is free is the one that produces
	 * the write storm.
	 *
	 * Evaluated once per head, on the first cycle it delivers usable SoC data. Repeating
	 * it would re-block a head the moment the split released it.
	 *
	 * @param heads the heads taking part in this cycle
	 */
	private seedSaturation(heads: HeadState[]): void {
		for (const h of heads) {
			// Without SoC data there is nothing to judge, and marking the head evaluated
			// on a placeholder would spend the single look on a value we invented.
			if (!h.controllable) {
				continue;
			}
			// A charge that has moved clear of a band lifts the block on sight. Waiting for
			// the split to hand out a non-zero setpoint misses the case where there is
			// nothing to hand out: with the house on target every head gets 0, so one that
			// charged past its floor meanwhile would stay blocked — and once its charge
			// drifts back into the band, for good.
			if (!inDischargeBand(h) && h.soc > h.socMin) {
				this.saturatedDischarge.delete(h.index);
			}
			if (!inChargeBand(h) && h.soc < h.socMax) {
				this.saturatedCharge.delete(h.index);
			}
			if (this.socEvaluated.has(h.index)) {
				continue;
			}
			this.socEvaluated.add(h.index);
			// The same two predicates the split uses to decide eligibility, so the
			// assumption made here and the release that ends it cannot drift apart.
			const dischargeBand = Math.max(0, h.socHysteresisDischarge);
			const chargeBand = Math.max(0, h.socHysteresisCharge);
			const blockedBelow = inDischargeBand(h);
			const blockedAbove = inChargeBand(h);
			if (blockedBelow && blockedAbove) {
				// Bands can overlap (SI + SI1 >= SA - SA1). Seeding both sides would be a trap with
				// no exit — each release waits for the other direction to move the charge — and the
				// device is never in that state, so the assumption is what is wrong, not the head.
				this.adapter.log.info(
					`Head ${h.index}: the SoC hysteresis bands overlap (${h.socMin}+${dischargeBand} reaches ` +
						`${h.socMax}-${chargeBand}) and the charge of ${h.soc}% falls in both — starting without ` +
						'an assumption about either direction.',
				);
				continue;
			}
			// Logged at info, not debug: it happens at most once per head and run, and it
			// is the answer to "why is my storage idle since the restart?".
			if (blockedBelow) {
				this.saturatedDischarge.add(h.index);
				this.adapter.log.info(
					`Head ${h.index}: SoC ${h.soc}% is inside the discharge hysteresis band ` +
						`(${h.socMin}…${h.socMin + dischargeBand}%) — assuming the device still blocks discharging ` +
						'until the charge leaves the band.',
				);
			}
			if (blockedAbove) {
				this.saturatedCharge.add(h.index);
				this.adapter.log.info(
					`Head ${h.index}: SoC ${h.soc}% is inside the charge hysteresis band ` +
						`(${h.socMax - chargeBand}…${h.socMax}%) — assuming the device still blocks charging ` +
						'until the charge leaves the band.',
				);
			}
		}
	}

	/**
	 * Writes one head's GS and mirrors it, isolating the failure: a head that is slow or
	 * unreachable must neither abort nor delay the others.
	 *
	 * @param index 1-based head number
	 * @param gs setpoint to write
	 * @returns true if the write succeeded
	 */
	private async writeHeadGs(index: number, gs: number): Promise<boolean> {
		if (this.stopped) {
			return false;
		}
		if (gs !== 0) {
			// Before the write: a request that goes out may be applied even when its response is
			// lost, and responsibility recorded only on success would miss that head.
			this.everCommanded.add(index);
		}
		try {
			await this.hooks.writeGs(index, gs);
			await this.hooks.reflectGs(index, gs);
			// A GS write changes real power, so the freshness gate moves with every one of them,
			// the safety paths included — a reading taken under the old setpoint would send the
			// first correction the wrong way.
			this.lastWriteDoneTs = Date.now();
			this.lastGs.set(index, gs);
			this.ffBase.set(index, gs);
			const failed = this.writeFailures.get(index);
			if (failed) {
				this.writeFailures.delete(index);
				this.adapter.log.info(`Head ${index}: GS writes are succeeding again (${failed.count} failed).`);
			}
			return true;
		} catch (e) {
			this.noteWriteFailure(index, errMsg(e));
			return false;
		}
	}

	/**
	 * Brings one head's IS to the given limit, skipping writes inside the dead band.
	 * Failures are recorded like GS failures so a dead head does not flood the log.
	 *
	 * @param index 1-based head number
	 * @param is the limit to write in W
	 * @param releasing true for the shutdown/failsafe release, which bypasses the stop
	 * gate and the rate limit because it is the write that hands the limit back
	 */
	private async writeHeadIs(index: number, is: number, releasing = false): Promise<void> {
		// No throttling write after stop(): it would arrive behind the shutdown release and
		// leave the inverter capped with nobody to lift it. The release itself is exempt.
		if (this.stopped && !releasing) {
			return;
		}
		// Releases bypass the rate limit — they are the write that hands the limit back —
		// but get their own, shorter back-off so a failing one is not retried endlessly.
		if (releasing) {
			const lastRelease = this.lastIsRelease.get(index) ?? 0;
			if (Date.now() - lastRelease < IS_RELEASE_RETRY_MS) {
				return;
			}
			this.lastIsRelease.set(index, Date.now());
		}
		const prev = this.lastIs.get(index);
		if (prev !== undefined && Math.abs(is - prev) < this.cfg.isWriteDeadBandW) {
			return;
		}
		// Throttle failures, not successes: IS caps the inverter output, so holding a
		// working write back while GS rises leaves the device on an old, smaller value.
		const now = Date.now();
		const failedAt = this.lastIsFailure.get(index);
		if (!releasing && failedAt !== undefined && now - failedAt < IS_RETRY_AFTER_FAILURE_MS) {
			return;
		}
		try {
			await this.hooks.writeIs(index, is);
			await this.hooks.reflectIs(index, is);
			this.lastIs.set(index, is);
			this.lastIsFailure.delete(index);
			this.lastIsRelease.delete(index);
			const failed = this.isWriteFailures.get(index);
			if (failed) {
				// Closed on success, like the GS path: otherwise the next outage is reported with a
				// failure count from the previous one.
				this.isWriteFailures.delete(index);
				this.adapter.log.info(`Head ${index}: IS writes are succeeding again (${failed.count} failed).`);
			}
			// An IS write moves real power too, so it has to age the freshness gate — a
			// meter sample from before it does not show its effect yet.
			this.lastWriteDoneTs = Date.now();
		} catch (e) {
			this.lastIsFailure.set(index, Date.now());
			// Counted separately from GS: a shared record let a failed IS write make the next GS
			// echo look like a recovery, which silently adopts a value that was never in doubt.
			this.noteWriteFailure(index, errMsg(e), this.isWriteFailures, 'IS');
		}
	}

	/**
	 * Restores IS to each head's maximum, so a controller that stops regulating (failsafe
	 * or shutdown) never leaves the inverter throttled at a limit nobody maintains.
	 */
	private async releaseIs(): Promise<void> {
		if (!this.cfg.controlIs) {
			return;
		}
		await Promise.all(
			this.hooks
				.getHeads()
				.filter(h => h.online)
				.map(h => this.writeHeadIs(h.index, Math.round(Math.abs(h.maxPower)), true)),
		);
	}

	/**
	 * Records a failed device write and logs it at most once per
	 * WRITE_FAILURE_LOG_INTERVAL_MS, so a permanently unreachable head does not flood
	 * the log with one warning per control cycle.
	 *
	 * @param index 1-based head number
	 * @param message the underlying error message
	 * @param into the bookkeeping map to record into; GS and IS keep separate ones so a
	 * failed IS write cannot make the next GS echo look like a recovery
	 * @param field the device field the failure is about, so the log names the right one
	 */
	private noteWriteFailure(
		index: number,
		message: string,
		into: Map<number, { count: number; lastLog: number }> = this.writeFailures,
		field = 'GS',
	): void {
		const now = Date.now();
		const prev = into.get(index);
		if (!prev) {
			into.set(index, { count: 1, lastLog: now });
			this.adapter.log.warn(`Head ${index}: ${field} write failed: ${message}`);
			return;
		}
		prev.count++;
		if (now - prev.lastLog >= WRITE_FAILURE_LOG_INTERVAL_MS) {
			const sinceSec = Math.round((now - prev.lastLog) / 1000);
			prev.lastLog = now;
			this.adapter.log.warn(
				`Head ${index}: ${field} write still failing (${prev.count} attempts, last ${sinceSec} s): ${message}`,
			);
		}
	}

	/**
	 * Reports a GS echo that does not match what we commanded, which means something
	 * outside this adapter wrote GS (the vendor app, or a second automation). Manual
	 * writes through ioBroker cannot cause this — those are rejected in controller mode.
	 *
	 * This only warns. Adopting the foreign value would make the loop follow whoever
	 * wrote last, and the P term corrects the resulting offset through the grid error
	 * anyway; what the operator needs is to learn that two controllers are fighting.
	 *
	 * @param index 1-based head number
	 * @param gs the head's polled GS echo in W
	 */
	public noteReportedGs(index: number, gs: number): void {
		if (!Number.isFinite(gs)) {
			return;
		}
		const commanded = this.lastGs.get(index);
		// Skip while a write is in flight or barely settled — that mismatch is our own.
		if (commanded === undefined || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
			return;
		}
		// A timeout is not proof the device ignored the write — the response may just have
		// been lost — so the echo is the truth and our record is stale.
		if (this.writeFailures.has(index)) {
			if (gs !== commanded) {
				this.adapter.log.info(
					`Head ${index}: adopting reported GS=${Math.round(gs)} W after a failed write ` +
						`(recorded ${commanded} W).`,
				);
				this.lastGs.set(index, Math.round(gs));
				this.ffBase.set(index, Math.round(gs));
				if (Math.round(gs) !== 0) {
					this.everCommanded.add(index);
				}
			}
			this.writeFailures.delete(index);
			return;
		}
		if (Math.abs(gs - commanded) <= FOREIGN_GS_DEVIATION_W) {
			return;
		}
		const now = Date.now();
		const last = this.lastForeignGsLog.get(index) ?? 0;
		if (now - last < FOREIGN_GS_LOG_INTERVAL_MS) {
			return;
		}
		this.lastForeignGsLog.set(index, now);
		this.adapter.log.warn(
			`Head ${index}: device reports GS=${Math.round(gs)} W but the controller commanded ${commanded} W — ` +
				'something else is writing GS (vendor app, or a second automation). Run only one zero feed-in ' +
				'control path at a time.',
		);
	}

	/**
	 * Writes the same GS to every head (used for start and failsafe), concurrently for
	 * the same reason as the regulation path.
	 *
	 * @param gs setpoint to write
	 * @param onlineOnly restrict to online heads and skip heads already at gs
	 * (used by the repeating failsafe tick to avoid retry/log spam on offline heads)
	 */
	private async writeAll(gs: number, onlineOnly = false): Promise<void> {
		const due = this.hooks.getHeads().filter(h => !onlineOnly || (h.online && this.lastGs.get(h.index) !== gs));
		await Promise.all(due.map(h => this.writeHeadGs(h.index, gs)));
	}

	/**
	 * Watchdog branch for a controller that has never received a single value from its
	 * grid source — a wrong state id, or a source written with ack=false (those values
	 * are dropped on purpose). Without this the loop would sit at the GS=0 written by
	 * start() forever while controller mode keeps the device's own regulation switched
	 * off, so the storage neither charges nor discharges and nothing reports a fault.
	 * Neutralises rather than assuming the start writes landed — see below.
	 */
	private async reportSourceNeverSeen(): Promise<void> {
		const waitedSec = (Date.now() - this.startedAt) / 1000;
		if (waitedSec < this.cfg.failsafeSec) {
			return;
		}
		if (!this.failsafeActive) {
			this.failsafeActive = true;
			await this.publishStatus();
			this.adapter.log.warn(
				`No value has ever arrived from the grid source "${this.gridStateId}" in ${Math.round(waitedSec)} s — ` +
					'the controller cannot regulate and every head is being neutralised. Check that the state id ' +
					'exists, that it is being updated, and that it is written with ack=true.',
			);
		}
		// Neutralise rather than assume start() succeeded: its writes are best-effort.
		// writeAll(0, true) skips heads already at 0, so a healthy install writes nothing.
		await this.neutralise();
	}

	/** Writes GS=0 to every online head and releases IS, guarded by the write lock. */
	private async neutralise(): Promise<void> {
		if (this.writeInProgress) {
			return;
		}
		this.writeInProgress = true;
		try {
			await this.writeAll(0, true);
			await this.releaseIs();
		} finally {
			this.writeInProgress = false;
		}
	}

	private async watchdogTick(): Promise<void> {
		if (!this.everSeenSource) {
			await this.reportSourceNeverSeen();
			return;
		}
		const ageSec = this.lastValidSampleTs ? (Date.now() - this.lastValidSampleTs) / 1000 : Infinity;

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
				await this.publishStatus();
				this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s → failsafe (all heads GS=0).`);
			}
			await this.neutralise();
		} else if (ageSec >= this.cfg.warnSec) {
			if (!this.warnLogged) {
				this.warnLogged = true;
				await this.publishStatus();
				this.adapter.log.info(`Warn: grid source without update for ${Math.round(ageSec)} s.`);
			}
		}
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
