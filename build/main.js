"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_api = require("./lib/api");
var import_controller = require("./lib/controller");
var import_states = require("./lib/states");
const WRITE_CONFIRM_DELAY_MS = 1500;
class Sunenergyxt500 extends utils.Adapter {
  api;
  controller;
  gridStateId = "";
  pollIntervalMs = 5e3;
  isConnected = false;
  /** Active control mode: off (monitoring), controller (Mode B) or device (Mode A). */
  controlMode = "off";
  /** Built meter-connection string (MD) for device mode; '' when unconfigured. */
  meterMd = "";
  /** Whether the MM-mismatch warning was already logged (reset once consistent). */
  mmGuardWarned = false;
  pollTimer;
  /** relative control state id → its definition */
  controlMap = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super({
      ...options,
      name: "sunenergyxt500"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await this.setState("info.connection", false, true);
    const host = (this.config.host || "").trim();
    if (!host) {
      this.log.error("No device host/IP configured. Please set it in the adapter settings.");
      return;
    }
    this.pollIntervalMs = Math.max(1e3, Math.round((Number(this.config.pollInterval) || 5) * 1e3));
    const timeoutMs = Math.max(1e3, Math.round(Number(this.config.requestTimeout) || 8e3));
    this.api = new import_api.SunEnergyXtApi(host, timeoutMs);
    this.controlMode = this.config.controlMode || "off";
    for (const def of import_states.controlDefs) {
      this.controlMap.set(def.id, def);
    }
    await this.createObjects();
    this.subscribeStates("control.*");
    if (this.controlMode === "device") {
      this.meterMd = (0, import_states.buildMeterMd)({
        type: this.config.meterType,
        id: this.config.meterId,
        tasmotaSubtype: this.config.meterTasmotaSubtype
      });
      if (!this.meterMd) {
        this.log.warn(
          "Device self-regulation selected, but the meter is not configured correctly \u2014 no meter is bound."
        );
      }
    }
    await this.enforceMode("startup");
    if (this.controlMode === "controller") {
      await this.setupController();
    }
    this.log.info(`Control mode: ${this.controlMode}. Polling ${host} every ${this.pollIntervalMs / 1e3}s.`);
    void this.pollLoop();
  }
  async setupController() {
    this.gridStateId = (this.config.gridPowerStateId || "").trim();
    if (!this.gridStateId) {
      this.log.warn("Controller enabled but no grid-power source state configured \u2014 controller not started.");
      return;
    }
    const cfg = {
      gain: Number(this.config.controllerGain) || 0.3,
      deadBandW: Number(this.config.controllerDeadBandW) || 20,
      minIntervalMs: Math.max(1e3, Number(this.config.controllerMinIntervalMs) || 5e3),
      maxPowerW: Number(this.config.controllerMaxPowerW) || 2400,
      inverted: !!this.config.gridPowerInverted,
      warnSec: Number(this.config.watchdogWarnSec) || 30,
      failsafeSec: Number(this.config.watchdogFailsafeSec) || 180
    };
    this.controller = new import_controller.Controller(this, this.api, this.gridStateId, cfg);
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
  async enforceMode(reason) {
    let payload = null;
    if (this.controlMode === "controller") {
      payload = { MM: 0, MD: "" };
    } else if (this.controlMode === "device") {
      if (!this.meterMd) {
        return;
      }
      payload = { MM: 1, MD: this.meterMd };
    }
    if (!payload) {
      return;
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
  async guardMeterMode(data) {
    if (this.controlMode === "off") {
      return;
    }
    if (this.controlMode === "device" && !this.meterMd) {
      return;
    }
    const want = this.controlMode === "controller" ? 0 : 1;
    const mm = Number(data.MM);
    if (!Number.isFinite(mm) || mm === want) {
      this.mmGuardWarned = false;
      return;
    }
    if (!this.mmGuardWarned) {
      this.mmGuardWarned = true;
      this.log.warn(
        `Device MM=${mm} does not match ${this.controlMode} mode (expected ${want}) \u2014 re-asserting. Another script or the app may be changing MM.`
      );
    }
    await this.enforceMode("guard");
  }
  /** Creates channel and state objects for all measurement, control and controller states. */
  async createObjects() {
    const ids = [
      ...import_states.measurementDefs.map((d) => d.id),
      ...import_states.controlDefs.map((d) => d.id),
      ...import_controller.controllerStateDefs.map((d) => d.id),
      "info.lastUpdate",
      "info.lastError"
    ];
    await this.ensureChannels(ids);
    for (const def of [...import_states.measurementDefs, ...import_states.controlDefs]) {
      await this.setObjectNotExistsAsync(def.id, {
        type: "state",
        common: {
          name: def.name,
          type: def.type,
          role: def.role,
          unit: def.unit,
          read: true,
          write: !!def.write,
          states: def.states,
          def: def.type === "string" ? "" : def.type === "boolean" ? false : 0
        },
        native: {}
      });
    }
    for (const def of import_controller.controllerStateDefs) {
      await this.setObjectNotExistsAsync(def.id, {
        type: "state",
        common: {
          name: def.name,
          type: def.type,
          role: def.role,
          unit: def.unit,
          read: true,
          write: false,
          def: def.type === "string" ? "" : 0
        },
        native: {}
      });
    }
    await this.setObjectNotExistsAsync("info.lastUpdate", {
      type: "state",
      common: {
        name: { en: "Last successful poll", de: "Letzte erfolgreiche Abfrage" },
        type: "string",
        role: "date",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.lastError", {
      type: "state",
      common: {
        name: { en: "Last error", de: "Letzter Fehler" },
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.rawResponse", {
      type: "state",
      common: {
        name: { en: "Raw /read response (JSON)", de: "Rohantwort /read (JSON)" },
        type: "string",
        role: "json",
        read: true,
        write: false,
        def: ""
      },
      native: {}
    });
  }
  /**
   * Ensures a channel object exists for every parent path of the given state ids.
   *
   * @param ids
   */
  async ensureChannels(ids) {
    const parents = /* @__PURE__ */ new Set();
    for (const id of ids) {
      const parts = id.split(".");
      for (let i = 1; i < parts.length; i++) {
        parents.add(parts.slice(0, i).join("."));
      }
    }
    for (const p of [...parents].sort()) {
      await this.setObjectNotExistsAsync(p, {
        type: "channel",
        common: { name: p.split(".").pop() || p },
        native: {}
      });
    }
  }
  async pollLoop() {
    await this.readAndApply();
    this.pollTimer = this.setTimeout(() => void this.pollLoop(), this.pollIntervalMs);
  }
  /** Reads the device once and writes all states (without rescheduling). */
  async readAndApply() {
    var _a, _b;
    try {
      const { reported: data, body } = await this.api.read();
      for (const def of [...import_states.measurementDefs, ...import_states.controlDefs]) {
        if (!def.derive && !(def.field in data)) {
          continue;
        }
        const raw = def.derive ? def.derive(data) : data[def.field];
        if (def.type === "string") {
          await this.setStateChangedAsync(def.id, asString(raw), true);
        } else if (def.type === "number") {
          const n = (0, import_states.roundTo)(raw, (_a = def.decimals) != null ? _a : 0, (_b = def.scale) != null ? _b : 1);
          if (n !== null) {
            await this.setStateChangedAsync(def.id, n, true);
          }
        }
      }
      await this.guardMeterMode(data);
      await this.setStateChangedAsync("info.rawResponse", body, true);
      if (!this.isConnected) {
        this.isConnected = true;
        await this.setState("info.connection", true, true);
      }
      await this.setStateChangedAsync("info.lastUpdate", (/* @__PURE__ */ new Date()).toISOString(), true);
      await this.setStateChangedAsync("info.lastError", "", true);
    } catch (e) {
      if (this.isConnected) {
        this.isConnected = false;
        await this.setState("info.connection", false, true);
      }
      await this.setStateChangedAsync("info.lastError", errMsg(e), true);
      this.log.warn(`Poll failed: ${errMsg(e)}`);
    }
  }
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    if (this.controller && id === this.gridStateId) {
      void this.controller.onGridPower(Number(state.val));
      return;
    }
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
  async handleControlWrite(relId, state) {
    const def = this.controlMap.get(relId);
    if (!def) {
      return;
    }
    let payload;
    if (def.field === "RT") {
      if (!state.val) {
        return;
      }
      payload = { RT: 1 };
    } else if (def.type === "string") {
      payload = { [def.field]: state.val == null ? "" : String(state.val) };
    } else {
      const n = (0, import_states.roundTo)(state.val, 0);
      if (n === null) {
        this.log.warn(`Ignoring invalid value for ${def.id}: ${state.val}`);
        return;
      }
      payload = { [def.field]: n };
    }
    (0, import_states.applyMeterModeCoupling)(def.field, payload);
    try {
      await this.api.write(payload);
      this.log.info(`Wrote ${JSON.stringify(payload)} to device.`);
      if (def.field !== "RT") {
        this.setTimeout(() => void this.readAndApply(), WRITE_CONFIRM_DELAY_MS);
      }
    } catch (e) {
      this.log.warn(`Write ${def.field} failed: ${errMsg(e)}`);
    }
  }
  onUnload(callback) {
    var _a;
    try {
      if (this.pollTimer) {
        this.clearTimeout(this.pollTimer);
      }
      (_a = this.controller) == null ? void 0 : _a.stop();
      callback();
    } catch {
      callback();
    }
  }
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
function asString(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
if (require.main !== module) {
  module.exports = (options) => new Sunenergyxt500(options);
} else {
  (() => new Sunenergyxt500())();
}
//# sourceMappingURL=main.js.map
