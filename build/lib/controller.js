"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var controller_exports = {};
__export(controller_exports, {
  ADAPTIVE_DEAD_BAND_W: () => ADAPTIVE_DEAD_BAND_W,
  ADAPTIVE_TIERS: () => ADAPTIVE_TIERS,
  MultiHeadController: () => MultiHeadController,
  adaptiveTierFor: () => adaptiveTierFor,
  controllerStateDefs: () => controllerStateDefs
});
module.exports = __toCommonJS(controller_exports);
var import_split = require("./split");
const ADAPTIVE_TIERS = [
  { maxErrorW: 30, intervalMs: 7e3, maxStepW: 20 },
  { maxErrorW: 150, intervalMs: 2500, maxStepW: 120 },
  { maxErrorW: Number.POSITIVE_INFINITY, intervalMs: 1e3, maxStepW: 450 }
];
const ADAPTIVE_DEAD_BAND_W = 5;
function adaptiveTierFor(errorAbsW) {
  var _a;
  return (_a = ADAPTIVE_TIERS.find((t) => errorAbsW < t.maxErrorW)) != null ? _a : ADAPTIVE_TIERS[ADAPTIVE_TIERS.length - 1];
}
const controllerStateDefs = [
  {
    id: "controller.status",
    type: "string",
    role: "text",
    name: { en: "Controller watchdog status (ok/warn/failsafe)", de: "Regler-Watchdog-Status (ok/warn/failsafe)" }
  },
  {
    id: "controller.gridPower",
    type: "number",
    role: "value.power",
    unit: "W",
    name: {
      en: "House grid power as seen by the controller (+draw / \u2212feed-in)",
      de: "Hausanschluss-Netzleistung wie vom Regler gesehen (+Bezug / \u2212Einspeisung)"
    }
  },
  {
    id: "controller.totalTarget",
    type: "number",
    role: "value.power",
    unit: "W",
    name: {
      en: "Total grid setpoint before the split (+discharge / \u2212charge)",
      de: "Gesamt-Sollwert vor der Aufteilung (+entladen / \u2212laden)"
    }
  },
  {
    id: "controller.gridSourceAge",
    type: "number",
    role: "value",
    unit: "s",
    name: { en: "Age of last grid-source value", de: "Alter des letzten Netzquelle-Werts" }
  },
  {
    id: "controller.maxGridSourceAge",
    type: "number",
    role: "value",
    unit: "s",
    name: { en: "Largest observed grid-source gap", de: "Gr\xF6\xDFte beobachtete Netzquelle-L\xFCcke" }
  }
];
const WATCHDOG_INTERVAL_MS = 15e3;
const SYNC_DEVIATION_W = 150;
const SYNC_MIN_AGE_MS = 1e4;
const STALE_SAMPLE_OVERRIDE_MS = 3e4;
const WRITE_FAILURE_LOG_INTERVAL_MS = 6e4;
const FOREIGN_GS_DEVIATION_W = 5;
const FOREIGN_GS_LOG_INTERVAL_MS = 3e5;
const IS_RETRY_AFTER_FAILURE_MS = 1e4;
const IS_RELEASE_RETRY_MS = 5e3;
const UNCONTROLLABLE_RETRY_MS = 1e4;
class MultiHeadController {
  /**
   * @param adapter the adapter instance (logging, states, timers)
   * @param hooks head snapshot and GS write callbacks provided by the adapter
   * @param gridStateId foreign state id of the grid-power source (watchdog checks its age)
   * @param cfg controller tuning parameters
   */
  constructor(adapter, hooks, gridStateId, cfg) {
    this.adapter = adapter;
    this.hooks = hooks;
    this.gridStateId = gridStateId;
    this.cfg = cfg;
  }
  /**
   * When the last write cycle *started*. Drives the tier interval: the rate limit is
   * about how often the controller reaches for the device, so it counts attempts.
   */
  lastWriteTime = 0;
  /**
   * When the last write cycle *finished*. Drives the sample-freshness gate, which is
   * about physics: a reading only reflects a new setpoint once that setpoint actually
   * reached the device. A write can sit queued behind a poll for seconds, so dating
   * the gate from the attempt would let readings taken during that wait through.
   */
  lastWriteDoneTs = 0;
  /** Last total setpoint actually dispatched, used to detect a real aggregate move. */
  lastTotalTarget = 0;
  /**
   * What we last successfully commanded each head — the adapter's record of the
   * device's actual setpoint. Safety decisions (failsafe neutralisation, the GS echo
   * comparison, the write dead band) read this and nothing else.
   */
  lastGs = /* @__PURE__ */ new Map();
  /**
   * Feed-forward base per head. Starts out equal to the commanded GS but is corrected
   * by the anti-windup sync when a device visibly does not follow it. Kept separate
   * from `lastGs`: adopting a measured value into the command record would make the
   * failsafe believe a head is already neutral when it is not.
   */
  ffBase = /* @__PURE__ */ new Map();
  lastIs = /* @__PURE__ */ new Map();
  writeInProgress = false;
  everSeenSource = false;
  /** Failsafe because the grid source is silent. Cleared by any usable sample. */
  failsafeActive = false;
  /**
   * Failsafe because no head can be regulated. Deliberately separate from
   * `failsafeActive`: that one is about the *source* and is rightly cleared by every
   * usable sample, while this one is about the *heads* and a fresh meter reading says
   * nothing about them. Sharing one flag made a healthy meter clear the head failsafe
   * on every sample, so status and log flipped once per reading.
   */
  headFailsafeActive = false;
  warnLogged = false;
  maxGapSec = 0;
  watchdogTimer;
  /** Start time, used to age out a source that never delivered a single value. */
  startedAt = 0;
  /** Set by stop(); every write path checks it so nothing escapes after shutdown. */
  stopped = false;
  /**
   * Timestamp of the last sample the loop could actually use. The watchdog runs on
   * this rather than on the raw state's `ts`: a source that keeps publishing values
   * the loop rejects — written with ack=false, or non-numeric — would otherwise look
   * perfectly healthy while nothing is regulating at all.
   */
  lastValidSampleTs = 0;
  /** Per-head write-failure bookkeeping, used to debounce the warning. */
  writeFailures = /* @__PURE__ */ new Map();
  /** Per-head timestamp of the last *failed* IS write; drives the retry back-off. */
  lastIsFailure = /* @__PURE__ */ new Map();
  /** Per-head timestamp of the last IS release attempt, so a failing one is throttled. */
  lastIsRelease = /* @__PURE__ */ new Map();
  /** IS write-failure bookkeeping, kept apart from the GS one (see writeHeadIs). */
  isWriteFailures = /* @__PURE__ */ new Map();
  /** Per-head timestamp of the last foreign-GS warning, used to debounce it. */
  lastForeignGsLog = /* @__PURE__ */ new Map();
  /**
   * Heads whose GS echo no longer matches the command record. The next write path
   * resends their setpoint even though `lastGs` says it is already in place — without
   * this a head that rebooted to GS=0 stays there for as long as the target holds still.
   */
  resendGs = /* @__PURE__ */ new Set();
  /** Per-head start of an episode without usable SoC data, used to warn once per episode. */
  notControllableSince = /* @__PURE__ */ new Map();
  /** Per-head timestamp of the last neutralisation attempt for an uncontrollable head. */
  lastUncontrollableTry = /* @__PURE__ */ new Map();
  /** Start of the current episode without any regulatable head; 0 when there is one. */
  noControllableSince = 0;
  /**
   * Heads held out by the *discharge* floor, and those held out by the *charge*
   * ceiling, kept apart.
   *
   * One shared set loses the information: a head that hit its discharge floor and is
   * then charged for a moment has its record cleared by that charge, so the discharge
   * hysteresis no longer applies and the loop commands power the device still refuses.
   * The two limits are independent, so their memories have to be too.
   */
  saturatedDischarge = /* @__PURE__ */ new Set();
  saturatedCharge = /* @__PURE__ */ new Set();
  /**
   * Heads whose SoC this controller has already evaluated at least once.
   *
   * The saturation memory above records what *this* run observed. After a restart —
   * or after forgetHead() dropped a head that went away and came back — it is empty,
   * so a head whose charge sits inside the device's hysteresis band looks free to
   * use. It is not: the device refuses until the band is cleared. See trackSaturation().
   */
  socEvaluated = /* @__PURE__ */ new Set();
  /**
   * Heads this controller has ever commanded. Survives forgetHead(), which drops the
   * per-head setpoint record: without it a head that went offline and came back would
   * look like one we never touched, and an old setpoint on it would be left alone.
   */
  everCommanded = /* @__PURE__ */ new Set();
  /** Consecutive cycles that only ran because of the stale-sample override. */
  overrideStreak = 0;
  /** Sets every head to a neutral GS=0 and starts the watchdog. */
  async start() {
    this.startedAt = Date.now();
    await this.writeAll(0);
    await this.publishStatus();
    this.adapter.log.info("Multi-head controller started \u2014 all heads GS=0.");
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
  stop() {
    this.stopped = true;
    if (this.watchdogTimer) {
      this.adapter.clearInterval(this.watchdogTimer);
      this.watchdogTimer = void 0;
    }
  }
  /**
   * Handle a new value of the configured grid-power source state.
   *
   * @param value raw source value
   * @param ts timestamp of the sample (ms); defaults to now for callers without one
   */
  async onGridPower(value, ts = Date.now()) {
    if (this.stopped || !Number.isFinite(value)) {
      return;
    }
    this.everSeenSource = true;
    this.lastValidSampleTs = Math.min(Math.max(this.lastValidSampleTs, ts), Date.now());
    if (this.failsafeActive || this.warnLogged) {
      if (this.failsafeActive) {
        this.adapter.log.info("Grid source is delivering \u2014 controller active.");
      }
      this.failsafeActive = false;
      this.warnLogged = false;
      if (!this.headFailsafeActive) {
        await this.publishStatus();
      }
    }
    const gridPower = this.cfg.inverted ? -value : value;
    await this.adapter.setStateChangedAsync("controller.gridPower", Math.round(gridPower), true);
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
  async publishStatus() {
    const status = this.failsafeActive || this.headFailsafeActive ? "failsafe" : this.warnLogged ? "warn" : "ok";
    await this.adapter.setStateChangedAsync("controller.status", status, true);
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
  sampleIsFresh(sampleTs, now) {
    if (!this.lastWriteDoneTs) {
      return true;
    }
    const stale = sampleTs <= this.lastWriteDoneTs + this.cfg.meterStabilizationMs;
    if (!stale) {
      this.overrideStreak = 0;
      return true;
    }
    if (now - this.lastWriteDoneTs >= STALE_SAMPLE_OVERRIDE_MS) {
      if (++this.overrideStreak === 3) {
        this.adapter.log.warn(
          `Grid source "${this.gridStateId}" keeps delivering samples timestamped before the last write. Its clock is probably behind this host \u2014 regulation is falling back to one correction per ${STALE_SAMPLE_OVERRIDE_MS / 1e3} s.`
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
  async regulate(gridPower, sampleTs) {
    if (this.stopped || this.writeInProgress) {
      return;
    }
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
  async runCycle(gridPower, sampleTs) {
    const error = gridPower - this.cfg.targetW;
    const tier = this.cfg.adaptive ? adaptiveTierFor(Math.abs(error)) : void 0;
    const minIntervalMs = tier ? tier.intervalMs : this.cfg.minIntervalMs;
    const deadBandW = tier ? ADAPTIVE_DEAD_BAND_W : this.cfg.deadBandW;
    const gain = tier ? 1 : this.cfg.gain;
    const maxStepW = tier ? tier.maxStepW : this.cfg.maxStepW;
    const now = Date.now();
    if (now - this.lastWriteTime < minIntervalMs) {
      return;
    }
    if (!this.sampleIsFresh(sampleTs, now)) {
      return;
    }
    const inDeadBand = Math.abs(error) < deadBandW;
    const all = this.hooks.getHeads();
    await this.handleUncontrollable(all);
    const heads = all.filter((h) => h.online && h.controllable);
    if (!heads.length) {
      await this.reportNoControllableHead(all);
      return;
    }
    if (this.noControllableSince || this.headFailsafeActive) {
      this.noControllableSince = 0;
      if (this.headFailsafeActive) {
        this.headFailsafeActive = false;
        this.adapter.log.info("A head is regulatable again \u2014 controller active.");
        await this.publishStatus();
      }
    }
    const base = heads.reduce(
      (acc, h) => {
        var _a;
        return acc + ((_a = this.ffBase.get(h.index)) != null ? _a : Number.isFinite(h.gp) ? h.gp : 0);
      },
      0
    );
    const sumExport = heads.reduce((acc, h) => acc + Math.abs(h.maxPower), 0);
    const sumCharge = heads.reduce((acc, h) => acc + Math.abs(h.maxCharge), 0);
    let totalTarget = inDeadBand ? Math.round(Math.max(-sumCharge, Math.min(sumExport, base))) : (0, import_split.computeTotalTarget)(base, error, gain, sumExport, sumCharge);
    if (maxStepW > 0 && !inDeadBand) {
      const lo = Math.max(base - maxStepW, -sumCharge);
      const hi = Math.min(base + maxStepW, sumExport);
      totalTarget = Math.round(Math.max(lo, Math.min(hi, totalTarget)));
    }
    await this.adapter.setStateChangedAsync("controller.totalTarget", totalTarget, true);
    this.trackSaturation(heads);
    const charging = totalTarget < 0;
    const memory = charging ? this.saturatedCharge : this.saturatedDischarge;
    const setpoints = (0, import_split.splitTarget)(totalTarget, heads, memory);
    for (const sp of setpoints) {
      if (sp.socLimited) {
        memory.add(sp.index);
      } else if (sp.gs !== 0) {
        memory.delete(sp.index);
      }
    }
    {
      const totalMoved = Math.abs(totalTarget - this.lastTotalTarget) >= this.cfg.writeDeadBandW;
      const due = setpoints.filter((sp) => {
        const prev = this.lastGs.get(sp.index);
        if (prev === void 0 || this.resendGs.has(sp.index)) {
          return true;
        }
        const moved = Math.abs(sp.gs - prev);
        if (moved === 0) {
          return false;
        }
        if (sp.gs === 0 && sp.socLimited) {
          return true;
        }
        return moved >= this.cfg.writeDeadBandW || totalMoved;
      });
      const results = await Promise.all(due.map((sp) => this.writeHeadGs(sp.index, sp.gs)));
      if (this.cfg.controlIs && !this.stopped) {
        const byIndex = new Map(setpoints.map((sp) => [sp.index, sp.gs]));
        await Promise.all(
          heads.map((h) => {
            var _a;
            return this.writeHeadIs(h.index, (0, import_split.computeIsTarget)(h, (_a = byIndex.get(h.index)) != null ? _a : 0));
          })
        );
      }
      if (results.length > 0 && results.every(Boolean)) {
        this.lastTotalTarget = totalTarget;
      }
      if (due.length) {
        this.lastWriteTime = now;
        this.lastWriteDoneTs = Date.now();
      }
      if (results.some(Boolean)) {
        this.adapter.log.debug(
          `Total target ${totalTarget} W \u2192 ${setpoints.map((s) => `H${s.index}:${s.gs}`).join(" ")} (grid ${Math.round(gridPower)} W)`
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
  noteReportedGp(index, gp) {
    if (!Number.isFinite(gp)) {
      return;
    }
    const last = this.ffBase.get(index);
    if (last === void 0 || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
      return;
    }
    if (Math.abs(gp - last) > SYNC_DEVIATION_W) {
      this.ffBase.set(index, Math.round(gp));
      this.adapter.log.debug(
        `Head ${index}: device delivers ${Math.round(gp)} W instead of commanded ${last} W \u2014 adopting as feed-forward base (anti-windup).`
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
  assumeCommanded(indexes) {
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
  forgetHead(index) {
    this.lastGs.delete(index);
    this.ffBase.delete(index);
    this.resendGs.delete(index);
    this.lastIs.delete(index);
    this.notControllableSince.delete(index);
    this.saturatedDischarge.delete(index);
    this.saturatedCharge.delete(index);
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
  async reportNoControllableHead(all) {
    if (!all.length) {
      return;
    }
    const now = Date.now();
    if (!this.noControllableSince) {
      this.noControllableSince = now;
      return;
    }
    const sinceSec = (now - this.noControllableSince) / 1e3;
    if (sinceSec < this.cfg.failsafeSec || this.headFailsafeActive) {
      return;
    }
    this.headFailsafeActive = true;
    await this.publishStatus();
    this.adapter.log.warn(
      `No head has been regulatable for ${Math.round(sinceSec)} s (offline, or reporting no usable SoC data) \u2014 nothing is regulating. Check the heads.`
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
  async handleUncontrollable(heads) {
    var _a;
    for (const h of heads) {
      if (h.online && !h.controllable) {
        if (this.cfg.controlIs && this.lastIs.get(h.index) !== Math.round(Math.abs(h.maxInverter))) {
          await this.writeHeadIs(h.index, Math.round(Math.abs(h.maxInverter)), true);
        }
        const commanded = this.lastGs.get(h.index);
        if (commanded === 0) {
          continue;
        }
        if (commanded === void 0 && !this.everCommanded.has(h.index)) {
          continue;
        }
        const lastTry = (_a = this.lastUncontrollableTry.get(h.index)) != null ? _a : 0;
        if (Date.now() - lastTry < UNCONTROLLABLE_RETRY_MS) {
          continue;
        }
        this.lastUncontrollableTry.set(h.index, Date.now());
        if (!this.notControllableSince.has(h.index)) {
          this.notControllableSince.set(h.index, Date.now());
          this.adapter.log.warn(
            // Not "reachable but …": a head stays a control participant for the first few failed
            // polls, so this also fires for one that has not answered yet.
            `Head ${h.index}: no usable SoC data (not answering, or an unexpected payload) \u2014 it cannot be regulated, so its setpoint (${commanded === void 0 ? "unknown" : `${commanded} W`}) is being cleared.`
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
   * Keeps the per-direction saturation memory in step with each head's charge, and
   * makes the conservative assumption for a head first seen inside a band.
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
  trackSaturation(heads) {
    for (const h of heads) {
      if (!h.controllable) {
        continue;
      }
      if (h.soc <= h.socMin) {
        this.saturatedDischarge.add(h.index);
      } else if (!(0, import_split.inDischargeBand)(h)) {
        this.saturatedDischarge.delete(h.index);
      }
      if (h.soc >= h.socMax) {
        this.saturatedCharge.add(h.index);
      } else if (!(0, import_split.inChargeBand)(h)) {
        this.saturatedCharge.delete(h.index);
      }
      if (this.socEvaluated.has(h.index)) {
        continue;
      }
      this.socEvaluated.add(h.index);
      const dischargeBand = Math.max(0, h.socHysteresisDischarge);
      const chargeBand = Math.max(0, h.socHysteresisCharge);
      const blockedBelow = (0, import_split.inDischargeBand)(h);
      const blockedAbove = (0, import_split.inChargeBand)(h);
      if (blockedBelow && blockedAbove) {
        this.adapter.log.info(
          `Head ${h.index}: the SoC hysteresis bands overlap (${h.socMin}+${dischargeBand} reaches ${h.socMax}-${chargeBand}) and the charge of ${h.soc}% falls in both \u2014 starting without an assumption about either direction.`
        );
        continue;
      }
      if (blockedBelow) {
        this.saturatedDischarge.add(h.index);
        this.adapter.log.info(
          `Head ${h.index}: SoC ${h.soc}% is inside the discharge hysteresis band (${h.socMin}\u2026${h.socMin + dischargeBand}%) \u2014 assuming the device still blocks discharging until the charge leaves the band.`
        );
      }
      if (blockedAbove) {
        this.saturatedCharge.add(h.index);
        this.adapter.log.info(
          `Head ${h.index}: SoC ${h.soc}% is inside the charge hysteresis band (${h.socMax - chargeBand}\u2026${h.socMax}%) \u2014 assuming the device still blocks charging until the charge leaves the band.`
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
  async writeHeadGs(index, gs) {
    if (this.stopped) {
      return false;
    }
    if (gs !== 0) {
      this.everCommanded.add(index);
    }
    try {
      await this.hooks.writeGs(index, gs);
      await this.hooks.reflectGs(index, gs);
      this.lastWriteDoneTs = Date.now();
      this.lastGs.set(index, gs);
      this.ffBase.set(index, gs);
      this.resendGs.delete(index);
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
  async writeHeadIs(index, is, releasing = false) {
    var _a;
    if (this.stopped && !releasing) {
      return;
    }
    if (releasing) {
      const lastRelease = (_a = this.lastIsRelease.get(index)) != null ? _a : 0;
      if (Date.now() - lastRelease < IS_RELEASE_RETRY_MS) {
        return;
      }
      this.lastIsRelease.set(index, Date.now());
    }
    const prev = this.lastIs.get(index);
    if (prev !== void 0 && Math.abs(is - prev) < this.cfg.isWriteDeadBandW) {
      return;
    }
    const now = Date.now();
    const failedAt = this.lastIsFailure.get(index);
    if (!releasing && failedAt !== void 0 && now - failedAt < IS_RETRY_AFTER_FAILURE_MS) {
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
        this.isWriteFailures.delete(index);
        this.adapter.log.info(`Head ${index}: IS writes are succeeding again (${failed.count} failed).`);
      }
      this.lastWriteDoneTs = Date.now();
    } catch (e) {
      this.lastIsFailure.set(index, Date.now());
      this.noteWriteFailure(index, errMsg(e), this.isWriteFailures, "IS");
    }
  }
  /**
   * Restores IS to each head's inverter maximum, so a controller that stops regulating
   * (failsafe or shutdown) never leaves the inverter throttled at a limit nobody
   * maintains. Deliberately not the export cap: releasing to MG would leave a head whose
   * owner capped feed-in unable to serve its own load port.
   */
  async releaseIs() {
    if (!this.cfg.controlIs) {
      return;
    }
    await Promise.all(
      this.hooks.getHeads().filter((h) => h.online).map((h) => this.writeHeadIs(h.index, Math.round(Math.abs(h.maxInverter)), true))
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
  noteWriteFailure(index, message, into = this.writeFailures, field = "GS") {
    const now = Date.now();
    const prev = into.get(index);
    if (!prev) {
      into.set(index, { count: 1, lastLog: now });
      this.adapter.log.warn(`Head ${index}: ${field} write failed: ${message}`);
      return;
    }
    prev.count++;
    if (now - prev.lastLog >= WRITE_FAILURE_LOG_INTERVAL_MS) {
      const sinceSec = Math.round((now - prev.lastLog) / 1e3);
      prev.lastLog = now;
      this.adapter.log.warn(
        `Head ${index}: ${field} write still failing (${prev.count} attempts, last ${sinceSec} s): ${message}`
      );
    }
  }
  /**
   * Reports a GS echo that does not match what we commanded, which means something
   * outside this adapter wrote GS (the vendor app, or a second automation). Manual
   * writes through ioBroker cannot cause this — those are rejected in controller mode.
   *
   * The foreign value is never adopted: that would make the loop follow whoever wrote
   * last. Instead the head is marked for a resend, so the next cycle puts the
   * controller's own setpoint back even if the target has not moved — and the operator
   * is told that two controllers are fighting. A device that restarted also lands here,
   * reporting GS=0 before the poll failures would have dropped it from the loop.
   *
   * @param index 1-based head number
   * @param gs the head's polled GS echo in W
   */
  noteReportedGs(index, gs) {
    var _a;
    if (!Number.isFinite(gs)) {
      return;
    }
    const commanded = this.lastGs.get(index);
    if (commanded === void 0 || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
      return;
    }
    if (this.writeFailures.has(index)) {
      if (gs !== commanded) {
        this.adapter.log.info(
          `Head ${index}: adopting reported GS=${Math.round(gs)} W after a failed write (recorded ${commanded} W).`
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
    this.resendGs.add(index);
    const now = Date.now();
    const last = (_a = this.lastForeignGsLog.get(index)) != null ? _a : 0;
    if (now - last < FOREIGN_GS_LOG_INTERVAL_MS) {
      return;
    }
    this.lastForeignGsLog.set(index, now);
    if (Math.round(gs) === 0) {
      this.adapter.log.info(
        `Head ${index}: device reports GS=0 W but the controller commanded ${commanded} W \u2014 it probably restarted. Sending the setpoint again.`
      );
      return;
    }
    this.adapter.log.warn(
      `Head ${index}: device reports GS=${Math.round(gs)} W but the controller commanded ${commanded} W \u2014 something else is writing GS (vendor app, or a second automation). Run only one zero feed-in control path at a time.`
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
  async writeAll(gs, onlineOnly = false) {
    const due = this.hooks.getHeads().filter((h) => !onlineOnly || h.online && (this.lastGs.get(h.index) !== gs || this.resendGs.has(h.index)));
    await Promise.all(due.map((h) => this.writeHeadGs(h.index, gs)));
  }
  /**
   * Watchdog branch for a controller that has never received a single value from its
   * grid source — a wrong state id, or a source written with ack=false (those values
   * are dropped on purpose). Without this the loop would sit at the GS=0 written by
   * start() forever while controller mode keeps the device's own regulation switched
   * off, so the storage neither charges nor discharges and nothing reports a fault.
   * Neutralises rather than assuming the start writes landed — see below.
   */
  async reportSourceNeverSeen() {
    const waitedSec = (Date.now() - this.startedAt) / 1e3;
    if (waitedSec < this.cfg.failsafeSec) {
      return;
    }
    if (!this.failsafeActive) {
      this.failsafeActive = true;
      await this.publishStatus();
      this.adapter.log.warn(
        `No value has ever arrived from the grid source "${this.gridStateId}" in ${Math.round(waitedSec)} s \u2014 the controller cannot regulate and every head is being neutralised. Check that the state id exists, that it is being updated, and that it is written with ack=true.`
      );
    }
    await this.neutralise();
  }
  /** Writes GS=0 to every online head and releases IS, guarded by the write lock. */
  async neutralise() {
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
  async watchdogTick() {
    if (!this.everSeenSource) {
      await this.reportSourceNeverSeen();
      return;
    }
    const ageSec = this.lastValidSampleTs ? (Date.now() - this.lastValidSampleTs) / 1e3 : Infinity;
    await this.adapter.setStateChangedAsync(
      "controller.gridSourceAge",
      Math.round(Number.isFinite(ageSec) ? ageSec : 0),
      true
    );
    if (Number.isFinite(ageSec) && ageSec > this.maxGapSec) {
      this.maxGapSec = ageSec;
      await this.adapter.setStateChangedAsync("controller.maxGridSourceAge", Math.round(this.maxGapSec), true);
    }
    if (ageSec >= this.cfg.failsafeSec) {
      if (!this.failsafeActive) {
        this.failsafeActive = true;
        await this.publishStatus();
        this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s \u2192 failsafe (all heads GS=0).`);
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
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ADAPTIVE_DEAD_BAND_W,
  ADAPTIVE_TIERS,
  MultiHeadController,
  adaptiveTierFor,
  controllerStateDefs
});
//# sourceMappingURL=controller.js.map
