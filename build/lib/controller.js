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
  lastWriteTime = 0;
  lastGs = /* @__PURE__ */ new Map();
  writeInProgress = false;
  everSeenSource = false;
  failsafeActive = false;
  warnLogged = false;
  maxGapSec = 0;
  watchdogTimer;
  /** Sets every head to a neutral GS=0 and starts the watchdog. */
  async start() {
    await this.writeAll(0);
    await this.adapter.setStateChangedAsync("controller.status", "ok", true);
    this.adapter.log.info("Multi-head controller started \u2014 all heads GS=0.");
    this.watchdogTimer = this.adapter.setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
  }
  /** Stops the watchdog; no further writes are issued by this instance. */
  stop() {
    if (this.watchdogTimer) {
      this.adapter.clearInterval(this.watchdogTimer);
      this.watchdogTimer = void 0;
    }
  }
  /**
   * Handle a new value of the configured grid-power source state.
   *
   * @param value raw source value
   */
  async onGridPower(value) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.everSeenSource = true;
    if (this.failsafeActive || this.warnLogged) {
      if (this.failsafeActive) {
        this.adapter.log.info("Grid source back \u2014 controller active again.");
      }
      this.failsafeActive = false;
      this.warnLogged = false;
      await this.adapter.setStateChangedAsync("controller.status", "ok", true);
    }
    await this.regulate(this.cfg.inverted ? -value : value);
  }
  /**
   * Computes the total setpoint, splits it and writes the per-head GS.
   *
   * @param gridPower normalized grid power (> 0 = draw)
   */
  async regulate(gridPower) {
    if (this.writeInProgress) {
      return;
    }
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
    if (Math.abs(error) < deadBandW) {
      return;
    }
    const heads = this.hooks.getHeads().filter((h) => h.online);
    if (!heads.length) {
      return;
    }
    const base = heads.reduce(
      (acc, h) => {
        var _a;
        return acc + ((_a = this.lastGs.get(h.index)) != null ? _a : Number.isFinite(h.gp) ? h.gp : 0);
      },
      0
    );
    const sumMax = heads.reduce((acc, h) => acc + Math.abs(h.maxPower), 0);
    let totalTarget = (0, import_split.computeTotalTarget)(base, error, gain, sumMax);
    if (maxStepW > 0) {
      const lo = Math.max(base - maxStepW, -sumMax);
      const hi = Math.min(base + maxStepW, sumMax);
      totalTarget = Math.round(Math.max(lo, Math.min(hi, totalTarget)));
    }
    const setpoints = (0, import_split.splitTarget)(totalTarget, heads);
    this.writeInProgress = true;
    try {
      let wroteAny = false;
      for (const sp of setpoints) {
        const prev = this.lastGs.get(sp.index);
        if (prev !== void 0 && Math.abs(sp.gs - prev) < this.cfg.writeDeadBandW) {
          continue;
        }
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
          `Total target ${totalTarget} W \u2192 ${setpoints.map((s) => `H${s.index}:${s.gs}`).join(" ")} (grid ${Math.round(gridPower)} W)`
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
  noteReportedGp(index, gp) {
    if (!Number.isFinite(gp)) {
      return;
    }
    const last = this.lastGs.get(index);
    if (last === void 0 || Date.now() - this.lastWriteTime < SYNC_MIN_AGE_MS) {
      return;
    }
    if (Math.abs(gp - last) > SYNC_DEVIATION_W) {
      this.lastGs.set(index, Math.round(gp));
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
  forgetHead(index) {
    this.lastGs.delete(index);
  }
  /**
   * Writes the same GS to every head (used for start and failsafe).
   *
   * @param gs setpoint to write
   * @param onlineOnly restrict to online heads and skip heads already at gs
   * (used by the repeating failsafe tick to avoid retry/log spam on offline heads)
   */
  async writeAll(gs, onlineOnly = false) {
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
  async watchdogTick() {
    if (!this.everSeenSource) {
      return;
    }
    let ageSec = Infinity;
    try {
      const st = await this.adapter.getForeignStateAsync(this.gridStateId);
      if (st && st.ts) {
        ageSec = (Date.now() - st.ts) / 1e3;
      }
    } catch {
    }
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
        await this.adapter.setStateChangedAsync("controller.status", "failsafe", true);
        this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s \u2192 failsafe (all heads GS=0).`);
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
        await this.adapter.setStateChangedAsync("controller.status", "warn", true);
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
