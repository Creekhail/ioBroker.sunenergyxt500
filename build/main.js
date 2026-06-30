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
const MAX_HEADS = 3;
const AGGREGATE_DEFS = [
  {
    id: "total.soc",
    role: "value.battery",
    unit: "%",
    name: { en: "Total state of charge (capacity-weighted)", de: "Gesamt-Ladezustand (kapazit\xE4tsgewichtet)" }
  },
  {
    id: "total.batteryPower",
    role: "value.power",
    unit: "W",
    name: { en: "Total battery power (+charge / \u2212discharge)", de: "Gesamt-Batterieleistung (+laden / \u2212entladen)" }
  },
  {
    id: "total.gridPower",
    role: "value.power",
    unit: "W",
    name: { en: "Total grid-port power (+feed-in)", de: "Gesamt-Netzleistung (+Einspeisung)" }
  },
  {
    id: "total.maxPower",
    role: "value.power",
    unit: "W",
    name: { en: "Total available power (online heads)", de: "Gesamt verf\xFCgbare Leistung (Online-K\xF6pfe)" }
  },
  {
    id: "total.onlineCount",
    role: "value",
    name: { en: "Online heads", de: "Online-K\xF6pfe" }
  }
];
class Sunenergyxt500 extends utils.Adapter {
  heads = [];
  pollIntervalMs = 5e3;
  /** Active control mode: off (monitoring), controller (Mode B) or device (Mode A, single head). */
  controlMode = "off";
  /** Built meter-connection string (MD) for device mode; '' when unconfigured. */
  meterMd = "";
  /** Per-head flag whether the MM-mismatch warning was already logged. */
  mmGuardWarned = /* @__PURE__ */ new Map();
  pollTimer;
  /** Active multi-head controller (controller mode only). */
  controller;
  /** Foreign grid-power source state id the controller subscribes to. */
  gridStateId = "";
  /** relative control state id (e.g. "control.GS") → its definition */
  controlMap = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super({
      ...options,
      name: "sunenergyxt500"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await this.setStateChangedAsync("info.connection", false, true);
    const timeoutMs = Math.max(1e3, Math.round(Number(this.config.requestTimeout) || 8e3));
    this.pollIntervalMs = Math.max(1e3, Math.round((Number(this.config.pollInterval) || 5) * 1e3));
    const configured = [
      { host: this.config.head1Host, label: this.config.head1Label },
      { host: this.config.head2Host, label: this.config.head2Label },
      { host: this.config.head3Host, label: this.config.head3Label }
    ];
    const seen = /* @__PURE__ */ new Set();
    this.heads = [];
    for (const c of configured) {
      const host = (c.host || "").trim();
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
        label: (c.label || "").trim(),
        api: new import_api.SunEnergyXtApi(host, timeoutMs),
        online: false,
        packs: 1,
        maxPower: 2400
      });
    }
    if (!this.heads.length) {
      this.log.error(
        "No storage head configured. Please add at least one head (host/IP) in the adapter settings."
      );
      return;
    }
    this.controlMode = this.config.controlMode || "off";
    if (this.controlMode === "device" && this.heads.length > 1) {
      this.log.error(
        `Device self-regulation is only available with a single head, but ${this.heads.length} are configured \u2014 falling back to monitoring (off). Use the adapter controller for multiple heads.`
      );
      this.controlMode = "off";
    }
    for (const def of import_states.controlDefs) {
      this.controlMap.set(def.id, def);
    }
    await this.createObjects();
    this.subscribeStates("heads.*.control.*");
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
    this.log.info(
      `Control mode: ${this.controlMode}. Polling ${this.heads.length} head(s) every ${this.pollIntervalMs / 1e3}s.`
    );
    void this.pollLoop();
  }
  /**
   * Creates all per-head, aggregate, controller and info objects for the current
   * configuration, then removes any object in this namespace that is no longer part
   * of the desired set (renamed/removed fields, restructures, fewer heads).
   */
  async createObjects() {
    const desired = /* @__PURE__ */ new Set();
    const defaultFor = (t) => t === "string" ? "" : t === "boolean" ? false : 0;
    const ensure = async (id, common) => {
      desired.add(id);
      await this.setObjectNotExistsAsync(id, { type: "state", common, native: {} });
    };
    for (const h of this.heads) {
      const base = `heads.${h.index}`;
      const name = h.label || `Head ${h.index}`;
      desired.add(base);
      await this.setObjectNotExistsAsync(base, { type: "device", common: { name }, native: {} });
      await this.extendObjectAsync(base, { common: { name } });
      for (const def of [...import_states.measurementDefs, ...import_states.controlDefs]) {
        await ensure(`${base}.${def.id}`, {
          name: def.name,
          type: def.type,
          role: def.role,
          unit: def.unit,
          read: true,
          write: !!def.write,
          states: def.states,
          def: defaultFor(def.type)
        });
      }
      await ensure(`${base}.info.online`, {
        name: { en: "Head reachable", de: "Kopf erreichbar" },
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
        def: false
      });
      await ensure(`${base}.info.lastError`, {
        name: { en: "Last error", de: "Letzter Fehler" },
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      });
      await ensure(`${base}.info.rawResponse`, {
        name: { en: "Raw /read response (JSON)", de: "Rohantwort /read (JSON)" },
        type: "string",
        role: "json",
        read: true,
        write: false,
        def: ""
      });
    }
    for (const def of import_controller.controllerStateDefs) {
      await ensure(def.id, {
        name: def.name,
        type: def.type,
        role: def.role,
        unit: def.unit,
        read: true,
        write: false,
        def: defaultFor(def.type)
      });
    }
    for (const def of AGGREGATE_DEFS) {
      await ensure(def.id, {
        name: def.name,
        type: "number",
        role: def.role,
        unit: def.unit,
        read: true,
        write: false,
        def: 0
      });
    }
    desired.add("info");
    desired.add("info.connection");
    await ensure("info.lastUpdate", {
      name: { en: "Last successful poll", de: "Letzte erfolgreiche Abfrage" },
      type: "string",
      role: "date",
      read: true,
      write: false,
      def: ""
    });
    await ensure("info.meterBound", {
      name: { en: "Meter bound by adapter (device mode)", de: "Z\xE4hler vom Adapter gebunden (Ger\xE4te-Modus)" },
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
      def: false
    });
    await this.ensureChannels([...desired]);
    const keep = /* @__PURE__ */ new Set();
    for (const id of desired) {
      keep.add(id);
      const parts = id.split(".");
      for (let i = 1; i < parts.length; i++) {
        keep.add(parts.slice(0, i).join("."));
      }
    }
    await this.pruneOrphans(keep);
  }
  /**
   * Ensures a channel object exists for every parent path of the given ids.
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
  /**
   * Deletes objects in this instance's namespace that are not part of the desired
   * set — the general "reconcile" step that keeps existing installs clean across
   * version changes, tree restructures and head-count changes.
   *
   * @param keep relative ids (states and channels) that must be preserved
   */
  async pruneOrphans(keep) {
    var _a;
    let all;
    try {
      all = await this.getAdapterObjectsAsync();
    } catch (e) {
      this.log.debug(`Object cleanup skipped (cannot list objects): ${errMsg(e)}`);
      return;
    }
    const prefix = `${this.namespace}.`;
    const toDelete = [];
    for (const fullId of Object.keys(all)) {
      const rel = fullId.startsWith(prefix) ? fullId.slice(prefix.length) : "";
      if (!rel) {
        continue;
      }
      const type = (_a = all[fullId]) == null ? void 0 : _a.type;
      if (type !== "state" && type !== "channel" && type !== "device" && type !== "folder") {
        continue;
      }
      if (!keep.has(rel)) {
        toDelete.push(rel);
      }
    }
    if (!toDelete.length) {
      return;
    }
    toDelete.sort((a, b) => b.split(".").length - a.split(".").length);
    for (const rel of toDelete) {
      try {
        await this.delObjectAsync(rel);
      } catch (e) {
        this.log.debug(`Could not delete obsolete object ${rel}: ${errMsg(e)}`);
      }
    }
    this.log.info(`Cleaned up ${toDelete.length} obsolete object(s).`);
  }
  async pollLoop() {
    for (const h of this.heads) {
      await this.readAndApplyHead(h);
    }
    await this.computeAggregates();
    this.pollTimer = this.setTimeout(() => void this.pollLoop(), this.pollIntervalMs);
  }
  /**
   * Reads one head once and mirrors its fields to heads.<n>.* (without rescheduling).
   *
   * @param h the head to poll
   */
  async readAndApplyHead(h) {
    var _a, _b, _c, _d, _e;
    const base = `heads.${h.index}`;
    try {
      const { reported: data, body } = await h.api.read();
      for (const def of [...import_states.measurementDefs, ...import_states.controlDefs]) {
        if (!def.derive && !(def.field in data)) {
          continue;
        }
        const raw = def.derive ? def.derive(data) : data[def.field];
        let value = null;
        if (def.type === "string") {
          value = asString(raw);
        } else if (def.type === "number") {
          value = (0, import_states.roundTo)(raw, (_a = def.decimals) != null ? _a : 0, (_b = def.scale) != null ? _b : 1);
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
      h.packs = Math.max(1, (_c = num(data.ON)) != null ? _c : 1);
      h.maxPower = (_d = num(data.MG)) != null ? _d : 2400;
      h.socMin = (_e = num(data.SI)) != null ? _e : num(data.SO);
      h.socMax = num(data.SA);
      if (!h.online) {
        h.online = true;
        await this.setState(`${base}.info.online`, true, true);
      }
      await this.setStateChangedAsync(`${base}.info.lastError`, "", true);
    } catch (e) {
      if (h.online || h.soc === void 0) {
        h.online = false;
        await this.setStateChangedAsync(`${base}.info.online`, false, true);
      }
      await this.setStateChangedAsync(`${base}.info.lastError`, errMsg(e), true);
      this.log.warn(`Head ${h.index} (${h.host}) poll failed: ${errMsg(e)}`);
    }
  }
  /** Computes the combined view across all online heads. */
  async computeAggregates() {
    const online = this.heads.filter((h) => h.online);
    await this.setStateChangedAsync("total.onlineCount", online.length, true);
    await this.setStateChangedAsync(
      "total.gridPower",
      Math.round(online.reduce((acc, h) => {
        var _a;
        return acc + ((_a = h.gp) != null ? _a : 0);
      }, 0)),
      true
    );
    await this.setStateChangedAsync(
      "total.batteryPower",
      Math.round(online.reduce((acc, h) => {
        var _a;
        return acc + ((_a = h.bp) != null ? _a : 0);
      }, 0)),
      true
    );
    await this.setStateChangedAsync(
      "total.maxPower",
      Math.round(online.reduce((acc, h) => acc + h.maxPower, 0)),
      true
    );
    const withSoc = online.filter((h) => h.soc !== void 0);
    if (withSoc.length) {
      const weight = withSoc.reduce((acc, h) => acc + h.packs, 0) || 1;
      const soc = withSoc.reduce((acc, h) => acc + h.soc * h.packs, 0) / weight;
      await this.setStateChangedAsync("total.soc", Math.round(soc * 10) / 10, true);
    }
    const connected = online.length > 0;
    await this.setStateChangedAsync("info.connection", connected, true);
    if (connected) {
      await this.setStateChangedAsync("info.lastUpdate", (/* @__PURE__ */ new Date()).toISOString(), true);
    }
  }
  /**
   * Mirrors a confirmed device value onto a writable control state with ack=true,
   * clearing a pending (ack=false) command once the device echoes the value back.
   *
   * @param id full control state id
   * @param value the value the device currently reports
   */
  async confirmControlState(id, value) {
    const cur = await this.getStateAsync(id);
    if (!cur || cur.val !== value || cur.ack !== true) {
      await this.setStateAsync(id, { val: value, ack: true });
    }
  }
  /**
   * Writes the device fields (MM/MD) required by the active control mode for every
   * head, so a leftover or externally-set mode cannot lame the chosen control path.
   *
   * @param reason context shown in the log line
   */
  async enforceMode(reason) {
    if (this.controlMode === "controller") {
      for (const h of this.heads) {
        await this.writeHead(h, { MM: 0, MD: "" }, reason);
      }
      await this.setMeterBoundByAdapter(false);
    } else if (this.controlMode === "device") {
      const h = this.heads[0];
      if (!h || !this.meterMd) {
        return;
      }
      await this.writeHead(h, { MM: 1, MD: this.meterMd }, reason);
      await this.setMeterBoundByAdapter(true);
    } else if (await this.isMeterBoundByAdapter()) {
      const h = this.heads[0];
      if (h) {
        await this.writeHead(h, { MM: 0, MD: "" }, "off-cleanup");
      }
      await this.setMeterBoundByAdapter(false);
      this.log.info("Releasing the adapter-managed meter binding (control mode is now off).");
    }
  }
  /**
   * Writes a payload to one head, logging the outcome without aborting the others.
   *
   * @param h the target head
   * @param payload device fields to write
   * @param reason context shown in the log line
   */
  async writeHead(h, payload, reason) {
    try {
      await h.api.write(payload);
      if (this.controlMode !== "off") {
        this.log.info(
          `Head ${h.index}: enforced ${this.controlMode} mode (${reason}): ${JSON.stringify(payload)}.`
        );
      }
    } catch (e) {
      this.log.warn(`Head ${h.index}: could not apply ${this.controlMode} mode: ${errMsg(e)}`);
    }
  }
  /** Whether the adapter currently holds a device-native meter binding it created. */
  async isMeterBoundByAdapter() {
    const st = await this.getStateAsync("info.meterBound");
    return !!(st == null ? void 0 : st.val);
  }
  /**
   * Persists whether the adapter currently holds a meter binding (device mode).
   *
   * @param bound
   */
  async setMeterBoundByAdapter(bound) {
    await this.setStateAsync("info.meterBound", { val: bound, ack: true });
  }
  /**
   * Keeps a head's self-consumption mode (MM) consistent with the chosen control
   * mode on every poll; re-asserts and warns once on mismatch.
   *
   * @param h the polled head
   * @param data its latest reported state
   */
  async guardMeterMode(h, data) {
    if (this.controlMode === "off") {
      return;
    }
    if (this.controlMode === "device" && (h.index !== 1 || !this.meterMd)) {
      return;
    }
    const want = this.controlMode === "controller" ? 0 : 1;
    const mm = num(data.MM);
    if (mm === void 0 || mm === want) {
      this.mmGuardWarned.set(h.index, false);
      return;
    }
    if (!this.mmGuardWarned.get(h.index)) {
      this.mmGuardWarned.set(h.index, true);
      this.log.warn(
        `Head ${h.index}: MM=${mm} does not match ${this.controlMode} mode (expected ${want}) \u2014 re-asserting. Another script or the app may be changing MM.`
      );
    }
    const payload = this.controlMode === "controller" ? { MM: 0, MD: "" } : { MM: 1, MD: this.meterMd };
    await this.writeHead(h, payload, "guard");
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
   * Sends a writable control field of one head to its device and confirms via re-read.
   *
   * @param relId relative state id, e.g. "heads.2.control.GS"
   * @param state the new state
   */
  async handleControlWrite(relId, state) {
    const m = /^heads\.(\d+)\.(.+)$/.exec(relId);
    if (!m) {
      return;
    }
    const def = this.controlMap.get(m[2]);
    const h = this.heads.find((x) => x.index === Number(m[1]));
    if (!def || !h) {
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
        this.log.warn(`Ignoring invalid value for ${relId}: ${state.val}`);
        return;
      }
      payload = { [def.field]: n };
    }
    (0, import_states.applyMeterModeCoupling)(def.field, payload);
    try {
      await h.api.write(payload);
      this.log.info(`Head ${h.index}: wrote ${JSON.stringify(payload)} to device.`);
      if (def.field !== "RT") {
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
  async onMessage(obj) {
    var _a;
    if (!obj || typeof obj !== "object" || obj.command !== "testConnections") {
      return;
    }
    const msg = (_a = obj.message) != null ? _a : {};
    const heads = Array.isArray(msg.heads) ? msg.heads : [];
    const timeoutMs = Math.max(1e3, Math.round(Number(this.config.requestTimeout) || 8e3));
    const lines = [];
    let failures = 0;
    let i = 0;
    for (const h of heads) {
      i++;
      const host = ((h == null ? void 0 : h.host) || "").trim();
      const name = ((h == null ? void 0 : h.label) || "").trim() || `Head ${i}`;
      if (!host) {
        continue;
      }
      try {
        const { reported } = await new import_api.SunEnergyXtApi(host, timeoutMs).read();
        const model = asString(reported.DevType) || "SunEnergyXT";
        const soc = num(reported.SC);
        lines.push(`\u2022 ${name} (${host}): OK \u2014 ${model}${soc !== void 0 ? `, SoC ${soc}%` : ""}`);
      } catch (e) {
        failures++;
        lines.push(`\u2022 ${name} (${host}): unreachable \u2014 ${errMsg(e)}`);
      }
    }
    const text = lines.length ? lines.join("\n") : "No head configured to test.";
    const response = failures > 0 || !lines.length ? { error: text } : { result: text };
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
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
  /** Starts the multi-head self-consumption controller (controller mode). */
  async setupController() {
    this.gridStateId = (this.config.gridPowerStateId || "").trim();
    if (!this.gridStateId) {
      this.log.warn(
        "Controller mode selected but no grid-power source state configured \u2014 controller not started."
      );
      return;
    }
    const cfg = {
      gain: Number(this.config.controllerGain) || 0.3,
      deadBandW: Number(this.config.controllerDeadBandW) || 20,
      minIntervalMs: Math.max(1e3, Number(this.config.controllerMinIntervalMs) || 5e3),
      writeDeadBandW: Math.max(0, Number(this.config.controllerWriteDeadBandW) || 50),
      inverted: !!this.config.gridPowerInverted,
      warnSec: Number(this.config.watchdogWarnSec) || 30,
      failsafeSec: Number(this.config.watchdogFailsafeSec) || 180
    };
    const hooks = {
      getHeads: () => this.headStates(),
      writeGs: async (index, gs) => {
        const h = this.heads.find((x) => x.index === index);
        if (h) {
          await h.api.write({ GS: gs });
        }
      },
      reflectGs: async (index, gs) => {
        await this.setStateChangedAsync(`heads.${index}.control.GS`, gs, true);
      }
    };
    this.controller = new import_controller.MultiHeadController(this, hooks, this.gridStateId, cfg);
    await this.subscribeForeignStatesAsync(this.gridStateId);
    await this.controller.start();
    this.log.info(
      `Self-consumption controller active on grid source "${this.gridStateId}" across ${this.heads.length} head(s).`
    );
  }
  /** Maps the current head runtime to the pure HeadState used by the controller and split. */
  headStates() {
    return this.heads.map((h) => {
      var _a, _b, _c, _d;
      return {
        index: h.index,
        online: h.online,
        gp: (_a = h.gp) != null ? _a : 0,
        soc: (_b = h.soc) != null ? _b : 0,
        socMin: (_c = h.socMin) != null ? _c : 0,
        socMax: (_d = h.socMax) != null ? _d : 100,
        maxPower: h.maxPower
      };
    });
  }
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : void 0;
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
