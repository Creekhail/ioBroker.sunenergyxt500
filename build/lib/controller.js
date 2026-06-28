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
  Controller: () => Controller,
  controllerStateDefs: () => controllerStateDefs
});
module.exports = __toCommonJS(controller_exports);
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
class Controller {
  constructor(adapter, api, gridStateId, cfg) {
    this.adapter = adapter;
    this.api = api;
    this.gridStateId = gridStateId;
    this.cfg = cfg;
  }
  lastWriteTime = 0;
  lastGS = null;
  writeInProgress = false;
  everSeenSource = false;
  failsafeActive = false;
  warnLogged = false;
  maxGapSec = 0;
  watchdogTimer;
  /** Sets GS to a neutral 0 and starts the watchdog. */
  async start() {
    try {
      await this.api.write({ GS: 0 });
      this.lastGS = 0;
      this.lastWriteTime = Date.now();
      await this.setGridSetpointState(0);
      this.adapter.log.info("Controller started \u2014 GS set to 0.");
    } catch (e) {
      this.adapter.log.warn(`Controller start error: ${errMsg(e)}`);
    }
    this.watchdogTimer = this.adapter.setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
  }
  stop() {
    if (this.watchdogTimer) {
      this.adapter.clearInterval(this.watchdogTimer);
      this.watchdogTimer = void 0;
    }
  }
  /**
   * Handle a new value of the configured grid-power source state.
   *
   * @param value
   */
  async onGridPower(value) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.everSeenSource = true;
    if (this.failsafeActive) {
      this.adapter.log.info("Grid source back \u2014 controller active again.");
    }
    if (this.failsafeActive || this.warnLogged) {
      this.failsafeActive = false;
      this.warnLogged = false;
      await this.adapter.setStateChangedAsync("controller.status", "ok", true);
    }
    await this.writeGS(this.normalize(value));
  }
  /**
   * Normalize the source value to the convention "> 0 = grid draw".
   *
   * @param value
   */
  normalize(value) {
    return this.cfg.inverted ? -value : value;
  }
  async writeGS(gridPower) {
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
      const { reported } = await this.api.read();
      const gp = Number(reported.GP);
      if (!Number.isFinite(gp)) {
        this.adapter.log.warn("Controller: invalid GP \u2014 no write.");
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
      this.adapter.log.debug(`GP=${Math.round(gp)} + \u0394=${delta} \u2192 GS=${gs} (source=${Math.round(gridPower)} W)`);
    } catch (e) {
      this.adapter.log.warn(`Controller error: ${errMsg(e)}`);
    } finally {
      this.writeInProgress = false;
    }
  }
  async writeFailsafeGS() {
    if (this.writeInProgress || this.lastGS === 0) {
      return;
    }
    this.writeInProgress = true;
    try {
      await this.api.write({ GS: 0 });
      this.lastGS = 0;
      this.lastWriteTime = Date.now();
      await this.setGridSetpointState(0);
      this.adapter.log.warn("FAILSAFE \u2014 grid source stale \u2192 GS set to 0.");
    } catch (e) {
      this.adapter.log.warn(`Controller failsafe write error: ${errMsg(e)}`);
    } finally {
      this.writeInProgress = false;
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
        this.adapter.log.warn(`Grid source stale for ${Math.round(ageSec)} s \u2192 failsafe.`);
      }
      await this.writeFailsafeGS();
    } else if (ageSec >= this.cfg.warnSec) {
      if (!this.warnLogged) {
        this.warnLogged = true;
        await this.adapter.setStateChangedAsync("controller.status", "warn", true);
        this.adapter.log.info(`Warn: grid source without update for ${Math.round(ageSec)} s.`);
      }
    }
  }
  async setGridSetpointState(gs) {
    await this.adapter.setStateChangedAsync("control.GS", gs, true);
  }
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Controller,
  controllerStateDefs
});
//# sourceMappingURL=controller.js.map
