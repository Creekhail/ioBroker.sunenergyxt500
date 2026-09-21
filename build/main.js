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
var import_name_translations = require("./lib/name-translations");
var import_poll_schedule = require("./lib/poll-schedule");
var import_states = require("./lib/states");
var import_values = require("./lib/values");
const WRITE_CONFIRM_DELAY_MS = 1500;
const MAX_HEADS = 3;
const CONTROL_DROP_AFTER_FAILURES = 3;
const CONTROL_WRITE_TIMEOUT_MS = 2500;
const ALL_DEFS = [...import_states.measurementDefs, ...import_states.controlDefs];
const MANAGED_ROOTS = /* @__PURE__ */ new Set(["heads", "total", "controller", "info"]);
const LEGACY_ROOTS = /* @__PURE__ */ new Set(["battery", "grid", "load", "pv", "system", "device", "meter", "ups", "fault", "control"]);
const OWNER_MARK = { createdBy: "sunenergyxt500" };
const UNLOAD_NEUTRALIZE_BUDGET_MS = 2e3;
const FOREIGN_RETRY_INTERVAL_MS = 6e4;
const FOREIGN_RETRY_WARN_AFTER = 10;
function loc(name) {
  var _a;
  return { ...(_a = import_name_translations.NAME_TRANSLATIONS[name.en]) != null ? _a : {}, ...name };
}
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
    // Explicitly "of the storages": this is the sum of the heads' own grid ports, not
    // the house connection. The controller's view of the latter is controller.gridPower.
    name: {
      en: "Storage grid-port power, total (+feed-in)",
      de: "Netzport-Leistung der Speicher, gesamt (+Einspeisung)"
    }
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
  /** Per-head flag whether the "no meter bound" warning was already logged. */
  msGuardWarned = /* @__PURE__ */ new Map();
  /** True while a meter-binding write is still owed to the device. */
  meterMdPending = false;
  /** One poll timer per head index — the heads run on independent, staggered cycles. */
  pollTimers = /* @__PURE__ */ new Map();
  /** Active multi-head controller (controller mode only). */
  controller;
  /** Foreign grid-power source state id the controller subscribes to. */
  gridStateId = "";
  /** Whether the "grid source writes with ack=false" warning was already logged. */
  gridAckWarned = false;
  /** Whether the "grid source is not numeric" warning was already logged. */
  gridValueWarned = false;
  /** relative control state id (e.g. "control.GS") → its definition */
  controlMap = /* @__PURE__ */ new Map();
  /** Last value confirmed (ack=true) per control state — avoids a DB read per field and poll. */
  confirmedCache = /* @__PURE__ */ new Map();
  /** Whether the aggregates were force-written once since start (clears quality 0x20). */
  aggregatesForced = false;
  /** True from the moment unload starts; blocks device writes from in-flight work. */
  stopping = false;
  /** True while a leftover setpoint from an earlier run still has to be cleared. */
  gsCleanupPending = false;
  /** Hosts already neutralised during that cleanup, keyed by hostKey(). */
  gsCleanupDone = /* @__PURE__ */ new Set();
  /** Hosts the pending cleanup still has to reach, as recorded by the previous run. */
  gsCleanupHosts = [];
  /**
   * Hosts from an earlier run that are no longer configured and could not be
   * neutralised yet. Carried into the ownership record so they are retried on the
   * next start instead of being forgotten.
   */
  pendingForeignHosts = [];
  /** When the unconfigured-host retry last ran, so it does not fire on every poll. */
  lastForeignRetry = 0;
  /**
   * When the meter-binding retry for unconfigured hosts last ran. Its own clock
   * rather than lastForeignRetry's: sharing one would let whichever job runs first
   * starve the other for a full interval.
   */
  lastMeterRetry = 0;
  /** When the inverter-limit retry for unconfigured hosts last ran; its own clock. */
  lastIsRetry = 0;
  /** Serialises read-modify-write updates of the inverter-limit claim. */
  isClaimQueue = Promise.resolve();
  /**
   * Clients for hosts that are not configured heads, keyed by hostKey().
   *
   * One per host rather than one per job: `maxSockets: 1` serialises a client, not
   * a device, and the start-up jobs run together — three of them would otherwise
   * open three connections to the same ESP32, whose socket table is very small.
   * Held only while those jobs run; see releaseForeignApis().
   */
  foreignApis = /* @__PURE__ */ new Map();
  /**
   * Consecutive failed cleanup retries per host, so a host that is gone for good is
   * reported rather than retried in silence forever.
   */
  foreignRetryFailures = /* @__PURE__ */ new Map();
  /**
   * The same bookkeeping for meter bindings. Its own map rather than sharing the one
   * above: the two jobs fail independently, and a merged count would report one
   * device's silence under the other job's remedy.
   */
  meterRetryFailures = /* @__PURE__ */ new Map();
  /** The same for the inverter-limit job. */
  isRetryFailures = /* @__PURE__ */ new Map();
  /** Hosts whose inverter limit still has to be handed back once their model is known, keyed by hostKey(). */
  isReleasePending = /* @__PURE__ */ new Set();
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
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    this.pollIntervalMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.pollInterval, 5) * 1e3));
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
      const key = (0, import_values.hostKey)(host);
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
        api: new import_api.SunEnergyXtApi(host, timeoutMs, this),
        online: false,
        packs: 1,
        maxPower: 2400,
        pollFailures: 0
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
    for (const def of ALL_DEFS) {
      if (def.write) {
        this.controlMap.set(def.id, def);
      }
    }
    await this.createObjects();
    for (const pattern of (0, import_states.subscribedControlPatterns)(ALL_DEFS)) {
      this.subscribeStates(pattern);
    }
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
    if (this.controlMode === "controller") {
      const src = (this.config.gridPowerStateId || "").trim();
      if (!src) {
        this.log.error(
          "Controller mode is selected but no grid-power source state is configured. Falling back to monitoring (off) and leaving the devices as they are \u2014 configure the source state, then restart the instance."
        );
        this.controlMode = "off";
      } else if (src.startsWith(`${this.name}.`)) {
        this.log.error(
          `The configured grid-power source "${src}" is one of this adapter's own states. That feeds the controller its own output and would drive it to the limit. Point it at your meter adapter instead. Falling back to monitoring (off).`
        );
        this.controlMode = "off";
      }
    }
    await this.enforceMode("startup", this.controlMode === "controller");
    if (this.controlMode === "controller") {
      const inherited = await this.isGsOwnedByAdapter();
      const [removed] = await Promise.all([
        this.cleanupRemovedHosts(),
        this.resumeIsOwnership(),
        this.releaseMeterBindings()
      ]);
      this.pendingForeignHosts = removed;
      await this.setupController(inherited);
    } else {
      await this.setState("controller.status", { val: "", ack: true });
      await this.setState("controller.totalTarget", { val: 0, ack: true });
      await this.setState("controller.gridPower", { val: 0, ack: true });
      await Promise.all([this.resumeGsOwnership(), this.resumeIsOwnership()]);
    }
    this.log.info(
      `Control mode: ${this.controlMode}. Polling ${this.heads.length} head(s) every ${this.pollIntervalMs / 1e3}s${this.heads.length > 1 ? ", staggered" : ""}.`
    );
    this.releaseForeignApis();
    this.lastForeignRetry = this.lastMeterRetry = this.lastIsRetry = Date.now();
    this.startPolling();
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
      await this.setObjectNotExistsAsync(id, { type: "state", common, native: { ...OWNER_MARK } });
      await this.extendObject(id, { common, native: { ...OWNER_MARK } });
    };
    desired.add("heads");
    await this.setObject("heads", {
      type: "folder",
      common: { name: { en: "Storage heads", de: "Speicherk\xF6pfe" } },
      native: { ...OWNER_MARK }
    });
    for (const h of this.heads) {
      const base = `heads.${h.index}`;
      const name = h.label || `Head ${h.index}`;
      desired.add(base);
      await this.setObjectNotExistsAsync(base, {
        type: "device",
        common: { name },
        native: { ...OWNER_MARK }
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
          def: defaultFor(def.type)
        });
      }
      await ensure(`${base}.info.online`, {
        name: loc({ en: "Head reachable", de: "Kopf erreichbar" }),
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
        def: false
      });
      await ensure(`${base}.info.lastError`, {
        name: loc({ en: "Last error", de: "Letzter Fehler" }),
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: ""
      });
      await ensure(`${base}.info.rawResponse`, {
        name: loc({ en: "Raw /read response (JSON)", de: "Rohantwort /read (JSON)" }),
        type: "string",
        role: "json",
        read: true,
        write: false,
        def: ""
      });
    }
    for (const def of import_controller.controllerStateDefs) {
      await ensure(def.id, {
        name: loc(def.name),
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
        name: loc(def.name),
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
      name: loc({ en: "Last successful poll", de: "Letzte erfolgreiche Abfrage" }),
      type: "string",
      role: "date",
      read: true,
      write: false,
      def: ""
    });
    await ensure("info.meterBound", {
      name: loc({ en: "Meter bound by adapter (device mode)", de: "Z\xE4hler vom Adapter gebunden (Ger\xE4te-Modus)" }),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
      def: false
    });
    await ensure("info.gsOwned", {
      name: loc({
        en: "Adapter holds a grid setpoint on the heads",
        de: "Adapter h\xE4lt einen Netz-Sollwert auf den K\xF6pfen"
      }),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
      def: false
    });
    await ensure("info.meterBoundHosts", {
      name: loc({
        en: "Heads the adapter bound a meter to (JSON list)",
        de: "K\xF6pfe, an die der Adapter einen Z\xE4hler gebunden hat (JSON-Liste)"
      }),
      type: "string",
      role: "json",
      read: true,
      write: false,
      def: "[]"
    });
    await ensure("info.isOwned", {
      name: loc({
        en: "Adapter holds a throttled inverter limit on the heads",
        de: "Adapter h\xE4lt eine gedrosselte Wechselrichter-Grenze auf den K\xF6pfen"
      }),
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
      def: false
    });
    await ensure("info.isOwnedHosts", {
      name: loc({
        en: "Heads an inverter limit was left on (JSON list)",
        de: "K\xF6pfe, auf denen eine Wechselrichter-Grenze hinterlassen wurde (JSON-Liste)"
      }),
      type: "string",
      role: "json",
      read: true,
      write: false,
      def: "[]"
    });
    await ensure("info.gsOwnedHosts", {
      name: loc({
        en: "Heads a grid setpoint was left on (JSON list)",
        de: "K\xF6pfe, auf denen ein Netz-Sollwert hinterlassen wurde (JSON-Liste)"
      }),
      type: "string",
      role: "json",
      read: true,
      write: false,
      def: "[]"
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
   * @param ids relative state ids whose ancestor channels must exist
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
        native: { ...OWNER_MARK }
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
  async pruneOrphans(keep) {
    var _a;
    let all;
    try {
      all = await this.getAdapterObjectsAsync();
    } catch (e) {
      this.log.debug(`Object cleanup skipped (cannot list objects): ${(0, import_values.errMsg)(e)}`);
      return;
    }
    const prefix = `${this.namespace}.`;
    const toDelete = [];
    for (const fullId of Object.keys(all)) {
      const rel = fullId.startsWith(prefix) ? fullId.slice(prefix.length) : "";
      if (!rel) {
        continue;
      }
      const root = rel.split(".")[0];
      const obj = all[fullId];
      const type = obj == null ? void 0 : obj.type;
      if (type !== "state" && type !== "channel" && type !== "device" && type !== "folder") {
        continue;
      }
      if (LEGACY_ROOTS.has(root)) {
        toDelete.push(rel);
        continue;
      }
      if (!MANAGED_ROOTS.has(root) || keep.has(rel)) {
        continue;
      }
      if (((_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.createdBy) !== OWNER_MARK.createdBy) {
        this.log.debug(`Keeping ${rel}: not created by this adapter.`);
        continue;
      }
      toDelete.push(rel);
    }
    if (!toDelete.length) {
      return;
    }
    toDelete.sort((a, b) => b.split(".").length - a.split(".").length);
    for (const rel of toDelete) {
      try {
        await this.delObjectAsync(rel);
      } catch (e) {
        this.log.debug(`Could not delete obsolete object ${rel}: ${(0, import_values.errMsg)(e)}`);
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
  startPolling() {
    for (const h of this.heads) {
      this.schedulePoll(h, (0, import_poll_schedule.pollStaggerMs)(h.index, this.heads.length, this.pollIntervalMs));
    }
  }
  /**
   * Schedules this head's next poll, replacing any pending timer for it.
   *
   * @param h the head to schedule
   * @param delayMs delay until the next poll
   */
  schedulePoll(h, delayMs) {
    const pending = this.pollTimers.get(h.index);
    if (pending) {
      this.clearTimeout(pending);
      this.pollTimers.delete(h.index);
    }
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
  async pollHead(h) {
    this.pollTimers.delete(h.index);
    try {
      const ok = await this.readAndApplyHead(h);
      h.pollFailures = ok ? 0 : h.pollFailures + 1;
      await this.computeAggregates();
    } catch (e) {
      h.pollFailures++;
      this.log.warn(`Head ${h.index}: unexpected error during poll: ${(0, import_values.errMsg)(e)}`);
    } finally {
      this.schedulePoll(h, (0, import_poll_schedule.pollBackoffMs)(this.pollIntervalMs, h.pollFailures));
    }
  }
  /**
   * Reads one head once and mirrors its fields to heads.<n>.* (without rescheduling).
   *
   * @param h the head to poll
   * @returns whether the read succeeded
   */
  async readAndApplyHead(h) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const base = `heads.${h.index}`;
    try {
      const { reported: data, body } = await h.api.read();
      const force = !h.firstPollDone;
      for (const def of ALL_DEFS) {
        if (!def.derive && !(def.field in data)) {
          continue;
        }
        const raw = def.derive ? def.derive(data) : data[def.field];
        let value = null;
        if (def.type === "string") {
          value = (0, import_values.asString)(raw);
        } else if (def.type === "number") {
          value = (0, import_states.roundTo)(raw, (_a = def.decimals) != null ? _a : 0, (_b = def.scale) != null ? _b : 1);
        } else if (def.type === "boolean" && def.role !== "button") {
          const n = (0, import_values.num)(raw);
          value = n === void 0 ? null : n !== 0;
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
      h.soc = (0, import_values.num)(data.SC);
      h.bp = (0, import_values.num)(data.BP);
      h.gp = (0, import_values.num)(data.GP);
      h.lp = (0, import_values.num)(data.LP);
      h.pv = (0, import_values.num)(data.PV);
      h.packs = Math.max(1, (_c = (0, import_values.num)(data.ON)) != null ? _c : 1);
      h.maxPower = (_d = (0, import_values.num)(data.MG)) != null ? _d : (0, import_values.fallbackMaxPower)(data);
      h.socMin = (_e = (0, import_values.num)(data.SI)) != null ? _e : (0, import_values.num)(data.SO);
      h.socMax = (0, import_values.num)(data.SA);
      h.socHysteresisDischarge = (0, import_values.num)(data.SI1);
      h.socHysteresisCharge = (0, import_values.num)(data.SA1);
      if (h.gp !== void 0) {
        (_f = this.controller) == null ? void 0 : _f.noteReportedGp(h.index, h.gp);
      }
      const reportedGs = (0, import_values.num)(data.GS);
      if (reportedGs !== void 0) {
        (_g = this.controller) == null ? void 0 : _g.noteReportedGs(h.index, reportedGs);
      }
      if (!h.online) {
        h.online = true;
        await this.setState(`${base}.info.online`, true, true);
      }
      await this.setStateChangedAsync(`${base}.info.lastError`, "", true);
      await this.retryGsCleanup(h);
      await this.retryForeignMeterRelease();
      await this.retryForeignIsRelease();
      await this.finishIsRelease(h);
      return true;
    } catch (e) {
      if (h.online) {
        h.online = false;
        await this.setStateChangedAsync(`${base}.info.online`, false, true);
      }
      if (h.pollFailures + 1 >= CONTROL_DROP_AFTER_FAILURES) {
        (_h = this.controller) == null ? void 0 : _h.forgetHead(h.index);
      }
      await this.setStateChangedAsync(`${base}.info.lastError`, (0, import_values.errMsg)(e), true);
      this.log.warn(`Head ${h.index} (${h.host}) poll failed: ${(0, import_values.errMsg)(e)}`);
      return false;
    }
  }
  /** Computes the combined view across all online heads. */
  async computeAggregates() {
    const online = this.heads.filter((h) => h.online);
    const force = !this.aggregatesForced && online.length > 0;
    const write = async (id, val) => {
      if (force) {
        await this.setState(id, { val, ack: true });
      } else {
        await this.setStateChangedAsync(id, val, true);
      }
    };
    await write("total.onlineCount", online.length);
    await write("total.gridPower", Math.round(online.reduce((acc, h) => {
      var _a;
      return acc + ((_a = h.gp) != null ? _a : 0);
    }, 0)));
    await write("total.batteryPower", Math.round(online.reduce((acc, h) => {
      var _a;
      return acc + ((_a = h.bp) != null ? _a : 0);
    }, 0)));
    await write("total.maxPower", Math.round(online.reduce((acc, h) => acc + h.maxPower, 0)));
    const withSoc = online.filter((h) => h.soc !== void 0);
    if (withSoc.length) {
      const weight = withSoc.reduce((acc, h) => acc + h.packs, 0) || 1;
      const soc = withSoc.reduce((acc, h) => acc + h.soc * h.packs, 0) / weight;
      await write("total.soc", Math.round(soc * 10) / 10);
    }
    if (force) {
      this.aggregatesForced = true;
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
   * Writes the device fields (MM/MD) required by the active control mode for every
   * head, so a leftover or externally-set mode cannot lame the chosen control path.
   *
   * @param reason context shown in the log line
   * @param deferForeignRelease controller mode only: leave the release of bindings on
   * hosts that are no longer configured to the caller, so it does not delay the heads
   * that are
   */
  async enforceMode(reason, deferForeignRelease = false) {
    if (this.controlMode === "controller") {
      for (const h of this.heads) {
        await this.writeHead(h, { MM: 0, MD: "" }, reason);
      }
      if (!deferForeignRelease) {
        await this.releaseMeterBindings();
      }
    } else if (this.controlMode === "device") {
      const h = this.heads[0];
      if (!h || !this.meterMd) {
        return;
      }
      await this.releaseMeterBindings(h.host);
      this.meterMdPending = !await this.writeHead(h, { MM: 1, MD: this.meterMd }, reason);
    } else if (await this.isMeterBoundByAdapter()) {
      await this.releaseMeterBindings();
      if (await this.isMeterBoundByAdapter()) {
        this.log.warn("Not every meter binding could be released yet \u2014 retrying as the heads answer.");
      } else {
        this.log.info("Released the adapter-managed meter binding (control mode is now off).");
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
  async writeHead(h, payload, reason) {
    if (this.stopping) {
      return false;
    }
    try {
      await h.api.write(payload);
      if (this.controlMode !== "off") {
        this.log.info(
          `Head ${h.index}: enforced ${this.controlMode} mode (${reason}): ${JSON.stringify(payload)}.`
        );
      }
      return true;
    } catch (e) {
      this.log.warn(`Head ${h.index}: could not apply ${this.controlMode} mode: ${(0, import_values.errMsg)(e)}`);
      return false;
    }
  }
  /** Whether the adapter currently holds a device-native meter binding it created. */
  async isMeterBoundByAdapter() {
    const st = await this.getStateAsync("info.meterBound");
    return !!(st == null ? void 0 : st.val);
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
  async isGsOwnedByAdapter() {
    const st = await this.getStateAsync("info.gsOwned");
    return !!(st == null ? void 0 : st.val);
  }
  /**
   * Records whether a setpoint of ours is standing on the heads.
   *
   * @param owned true once a setpoint has been (or is about to be) written
   */
  async setGsOwnedByAdapter(owned) {
    await this.setState("info.gsOwned", { val: owned, ack: true });
    const hosts = owned ? [.../* @__PURE__ */ new Set([...this.heads.map((h) => h.host), ...this.pendingForeignHosts])] : [];
    await this.setState("info.gsOwnedHosts", { val: JSON.stringify(hosts), ack: true });
  }
  /**
   * Hosts a previous run left a setpoint on, as recorded at the time.
   *
   * Falls back to the currently configured heads when the record is missing or
   * unreadable — that is what an installation upgrading from a version without this
   * state looks like, and trying the current heads is better than trying none.
   */
  async gsOwnedHosts() {
    return this.readHostList(
      "info.gsOwnedHosts",
      this.heads.map((h) => h.host)
    );
  }
  /**
   * Reads a JSON host list written by this adapter.
   *
   * @param id the state holding the list
   * @param fallback what to assume when the record is missing or unreadable
   */
  async readHostList(id, fallback) {
    const st = await this.getStateAsync(id);
    const raw = typeof (st == null ? void 0 : st.val) === "string" ? st.val : "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length) {
          return parsed;
        }
      } catch {
        this.log.warn(`${id} is not valid JSON (${raw}) \u2014 falling back to the currently configured heads.`);
      }
    }
    return fallback;
  }
  /**
   * Records the heads a meter binding of ours currently sits on.
   *
   * A list rather than a single host, for the same reason as gsOwnedHosts: head 1
   * can be repointed at another device while the old one still carries our binding,
   * and a release that fails has to stay on the record until it succeeds. The plain
   * boolean is kept in step so installations upgrading from a version that only had
   * it keep working.
   *
   * @param hosts every host that carries a binding of ours right now
   */
  async setMeterBoundHosts(hosts) {
    const unique = [...new Map(hosts.map((h) => [(0, import_values.hostKey)(h), h])).values()];
    await this.setState("info.meterBound", { val: unique.length > 0, ack: true });
    await this.setState("info.meterBoundHosts", { val: JSON.stringify(unique), ack: true });
  }
  /**
   * A client for a host with no configured head, shared with any job running at
   * the same moment so requests to one device queue behind each other.
   *
   * @param host the address to talk to
   * @param timeoutMs request deadline
   */
  foreignApi(host, timeoutMs) {
    const key = (0, import_values.hostKey)(host);
    let api = this.foreignApis.get(key);
    if (!api) {
      api = new import_api.SunEnergyXtApi(host, timeoutMs, this);
      this.foreignApis.set(key, api);
    }
    return api;
  }
  /** Closes every shared throwaway client, once the jobs using them are done. */
  releaseForeignApis() {
    for (const api of this.foreignApis.values()) {
      api.destroy();
    }
    this.foreignApis.clear();
  }
  /**
   * Heads a binding of ours sits on.
   *
   * Falls back to head 1 when only the old boolean exists — that is what an install
   * upgrading from a version without the list looks like, and head 1 is the only
   * head device mode ever binds.
   */
  async meterBoundHosts() {
    var _a;
    if (!await this.isMeterBoundByAdapter()) {
      return [];
    }
    const fallbackHost = (_a = this.heads[0]) == null ? void 0 : _a.host;
    return this.readHostList("info.meterBoundHosts", fallbackHost ? [fallbackHost] : []);
  }
  /**
   * Releases meter bindings of ours on every recorded host except the one the caller
   * is about to keep, and updates the record to what is actually left behind.
   *
   * Every startup branch goes through here before it touches the record. Overwriting
   * it unread was the same mistake gsOwnedHosts made: the entry is the only trace of
   * a device that is still self-regulating from our meter, and losing it leaves two
   * controllers working one battery with nobody aware of it.
   *
   * @param keep the host whose binding stays (empty when all of them go)
   */
  async releaseMeterBindings(keep = "") {
    if (this.stopping) {
      return;
    }
    const recorded = await this.meterBoundHosts();
    const keepKey = (0, import_values.hostKey)(keep);
    const stale = recorded.filter((host) => (0, import_values.hostKey)(host) !== keepKey);
    if (!stale.length) {
      await this.setMeterBoundHosts(keep ? [keep] : []);
      return;
    }
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    const left = [];
    await Promise.all(
      stale.map(async (host) => {
        var _a;
        const known = this.heads.find((x) => (0, import_values.hostKey)(x.host) === (0, import_values.hostKey)(host));
        const api = (_a = known == null ? void 0 : known.api) != null ? _a : this.foreignApi(host, timeoutMs);
        try {
          await api.write({ MM: 0, MD: "" });
          this.meterRetryFailures.delete((0, import_values.hostKey)(host));
          this.log.info(`Head ${host}: released the adapter-managed meter binding.`);
        } catch (e) {
          this.reportRetryFailure(
            this.meterRetryFailures,
            host,
            "releasing the adapter-managed meter binding",
            "info.meterBoundHosts",
            (0, import_values.errMsg)(e)
          );
          left.push(host);
        }
      })
    );
    await this.setMeterBoundHosts(keep ? [keep, ...left] : left);
  }
  /** Whether a throttled inverter limit of ours may still stand on a head. */
  async isIsOwnedByAdapter() {
    const st = await this.getStateAsync("info.isOwned");
    return !!(st == null ? void 0 : st.val);
  }
  /**
   * Records that a throttled inverter limit of ours stands on the given heads.
   *
   * Separate from gsOwned because the two claims end at different moments: GS is
   * cleared as soon as a zero lands, while IS can only be handed back once the head's
   * real maximum is known, which takes a successful poll. Keeping this in RAM meant
   * that whether a limit of ours was standing anywhere was inferred from whether the
   * option happens to be enabled *now* — a fact about the past read off the present.
   *
   * @param hosts every host that carries a limit of ours right now
   */
  async setIsOwnedHosts(hosts) {
    const unique = [...new Map(hosts.map((h) => [(0, import_values.hostKey)(h), h])).values()];
    await this.setState("info.isOwned", { val: unique.length > 0, ack: true });
    await this.setState("info.isOwnedHosts", { val: JSON.stringify(unique), ack: true });
  }
  /**
   * Adds the current heads to the inverter-limit claim without dropping what is
   * already on it.
   *
   * Replacing the list was the same mistake gsOwnedHosts made in an earlier round: a
   * host that is no longer configured and could not be reached stays on the claim on
   * purpose, and a plain overwrite two lines later loses the only record that its
   * inverter is still throttled.
   */
  async claimIsForCurrentHeads() {
    const outstanding = await this.isOwnedHosts();
    const configured = new Set(this.heads.map((h) => (0, import_values.hostKey)(h.host)));
    await this.setIsOwnedHosts([
      ...this.heads.map((h) => h.host),
      ...outstanding.filter((host) => !configured.has((0, import_values.hostKey)(host)))
    ]);
  }
  /** Heads a throttled inverter limit of ours may sit on. */
  async isOwnedHosts() {
    if (!await this.isIsOwnedByAdapter()) {
      return [];
    }
    return this.readHostList(
      "info.isOwnedHosts",
      this.heads.map((h) => h.host)
    );
  }
  /**
   * Drops one host from the inverter-limit claim once its limit has been handed back.
   *
   * @param host the head that confirmed the release
   */
  async clearIsClaim(host) {
    const op = async () => {
      const left = (await this.isOwnedHosts()).filter((x) => (0, import_values.hostKey)(x) !== (0, import_values.hostKey)(host));
      await this.setIsOwnedHosts(left);
    };
    const run = this.isClaimQueue.then(op, op);
    this.isClaimQueue = run.catch(() => void 0);
    await run;
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
      const bound = await this.meterBoundHosts();
      if (!bound.some((host) => (0, import_values.hostKey)(host) === (0, import_values.hostKey)(h.host))) {
        return;
      }
      const mm2 = (0, import_values.num)(data.MM);
      if (mm2 === 1) {
        if (await this.writeHead(h, { MM: 0, MD: "" }, "off-cleanup retry")) {
          await this.setMeterBoundHosts(bound.filter((x) => (0, import_values.hostKey)(x) !== (0, import_values.hostKey)(h.host)));
          this.log.info(`Head ${h.index}: released the adapter-managed meter binding (control mode is off).`);
        }
      } else if (mm2 === 0) {
        await this.setMeterBoundHosts(bound.filter((x) => (0, import_values.hostKey)(x) !== (0, import_values.hostKey)(h.host)));
      }
      return;
    }
    if (this.controlMode === "device" && (h.index !== 1 || !this.meterMd)) {
      return;
    }
    if (this.controlMode === "device" && this.meterMdPending) {
      if (await this.writeHead(h, { MM: 1, MD: this.meterMd }, "meter-binding retry")) {
        this.meterMdPending = false;
      }
      return;
    }
    const want = this.controlMode === "controller" ? 0 : 1;
    const mm = (0, import_values.num)(data.MM);
    if (mm === void 0 || mm === want) {
      this.mmGuardWarned.set(h.index, false);
      if (this.controlMode === "device" && mm === 1) {
        await this.guardMeterStatus(h, data);
      }
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
  async guardMeterStatus(h, data) {
    const ms = (0, import_values.num)(data.MS);
    if (ms !== 0) {
      this.msGuardWarned.set(h.index, false);
      return;
    }
    if (!this.msGuardWarned.get(h.index)) {
      this.msGuardWarned.set(h.index, true);
      this.log.warn(
        `Head ${h.index}: MM=1 but the device reports no meter bound (MS=0) \u2014 the meter connection string did not take effect. Re-sending it.`
      );
    }
    await this.writeHead(h, { MM: 1, MD: this.meterMd }, "meter-status-guard");
  }
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    if (this.controller && id === this.gridStateId) {
      if (state.ack) {
        const raw = state.val;
        if (raw === null || raw === void 0 || raw === "" || typeof raw === "boolean") {
          if (!this.gridValueWarned) {
            this.gridValueWarned = true;
            this.log.warn(
              `Grid source "${id}" delivered a non-numeric value (${JSON.stringify(raw)}) \u2014 ignoring it. The controller needs a number in watts.`
            );
          }
          return;
        }
        void this.controller.onGridPower(Number(raw), state.ts || Date.now()).catch((e) => {
          this.log.error(`Control cycle failed: ${(0, import_values.errMsg)(e)}`);
        });
      } else if (!this.gridAckWarned) {
        this.gridAckWarned = true;
        this.log.warn(
          `Grid source "${id}" is written with ack=false \u2014 such values are ignored, so the controller never regulates. Point it at the sensor state of the meter adapter, or make the writing script acknowledge its value (setState(id, value, true)).`
        );
      }
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
    var _a, _b;
    const m = /^heads\.(\d+)\.(.+)$/.exec(relId);
    if (!m) {
      return;
    }
    const def = this.controlMap.get(m[2]);
    const h = this.heads.find((x) => x.index === Number(m[1]));
    if (!def || !h) {
      return;
    }
    if (def.field === "GS" && this.controller) {
      this.log.warn(
        `Head ${h.index}: ignoring manual GS write \u2014 the controller owns GS in controller mode (set the control mode to off for manual GS control).`
      );
      return;
    }
    if (def.field === "LM" && !state.val && this.controlMode !== "off") {
      this.log.warn(
        `Head ${h.index}: refusing to disable local mode (LM) while control mode is "${this.controlMode}" \u2014 the adapter would lose access while a setpoint is active. Set the control mode to off first.`
      );
      return;
    }
    if (def.field === "IS" && this.controller && this.config.controllerControlIs) {
      this.log.warn(
        `Head ${h.index}: ignoring manual IS write \u2014 the controller steers IS while "Also steer the inverter limit" is enabled. Turn that option off for manual IS control.`
      );
      return;
    }
    this.confirmedCache.delete(relId);
    let payload;
    if (def.field === "RT") {
      if (!state.val) {
        return;
      }
      payload = { RT: 1 };
    } else if (def.type === "boolean") {
      payload = { [def.field]: state.val ? 1 : 0 };
    } else if (def.type === "string") {
      payload = { [def.field]: state.val == null ? "" : String(state.val) };
    } else {
      const n = (0, import_states.roundTo)(state.val, 0);
      if (n === null) {
        this.log.warn(`Ignoring invalid value for ${relId}: ${state.val}`);
        return;
      }
      if (def.min !== void 0 && n < def.min || def.max !== void 0 && n > def.max) {
        this.log.warn(
          `Ignoring out-of-range value for ${relId}: ${n} (allowed ${(_a = def.min) != null ? _a : "-\u221E"}\u2026${(_b = def.max) != null ? _b : "\u221E"}).`
        );
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
      this.log.warn(`Head ${h.index}: write ${def.field} failed: ${(0, import_values.errMsg)(e)}`);
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
    const heads = Array.isArray(msg.heads) ? msg.heads.filter((h) => !!h && typeof h === "object") : [];
    const str = (v) => typeof v === "string" ? v.trim() : "";
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    const lines = [];
    let failures = 0;
    let i = 0;
    for (const h of heads) {
      i++;
      const host = str(h == null ? void 0 : h.host);
      const name = str(h == null ? void 0 : h.label) || `Head ${i}`;
      if (!host) {
        continue;
      }
      const api = new import_api.SunEnergyXtApi(host, timeoutMs, this);
      try {
        const { reported } = await api.read();
        const model = (0, import_values.asString)(reported.DevType) || "SunEnergyXT";
        const soc = (0, import_values.num)(reported.SC);
        lines.push(`\u2022 ${name} (${host}): OK \u2014 ${model}${soc !== void 0 ? `, SoC ${soc}%` : ""}`);
      } catch (e) {
        failures++;
        lines.push(`\u2022 ${name} (${host}): unreachable \u2014 ${(0, import_values.errMsg)(e)}`);
      } finally {
        api.destroy();
      }
    }
    const text = lines.length ? lines.join("\n") : "No head configured to test.";
    const response = failures > 0 || !lines.length ? { error: text } : { result: text };
    if (obj.callback) {
      this.sendTo(obj.from, obj.command, response, obj.callback);
    }
  }
  onUnload(callback) {
    this.stopping = true;
    void (async () => {
      try {
        for (const timer of this.pollTimers.values()) {
          this.clearTimeout(timer);
        }
        this.pollTimers.clear();
        if (this.controller) {
          this.controller.stop();
          let budget;
          const cleared = await Promise.race([
            this.neutralizeAllGs(),
            new Promise((resolve) => {
              budget = setTimeout(() => resolve(false), UNLOAD_NEUTRALIZE_BUDGET_MS);
            })
          ]);
          clearTimeout(budget);
          const stillRecorded = new Set((await this.gsOwnedHosts()).map(import_values.hostKey));
          const outstanding = this.pendingForeignHosts.filter((host) => stillRecorded.has((0, import_values.hostKey)(host)));
          if (cleared && !outstanding.length) {
            await this.setGsOwnedByAdapter(false);
          } else if (cleared) {
            await this.setState("info.gsOwned", { val: true, ack: true });
            await this.setState("info.gsOwnedHosts", {
              val: JSON.stringify(outstanding),
              ack: true
            });
            this.log.warn(
              `Heads from an earlier run still carry a setpoint (${outstanding.join(", ")}) \u2014 the next start will neutralise them.`
            );
          } else {
            this.log.warn(
              "Could not confirm GS=0 on every head within the shutdown budget \u2014 the next start will neutralise them again."
            );
          }
        }
      } catch {
      } finally {
        for (const h of this.heads) {
          h.api.destroy();
        }
        this.releaseForeignApis();
        callback();
      }
    })();
  }
  /**
   * The payload that neutralises one head, with the inverter limit handed back only
   * when this adapter is holding one *and* the head's real maximum is known.
   *
   * Built in one place because the condition is easy to get wrong: before the first
   * poll `maxPower` is the constructor default of 2400, which would hand a 500 three
   * times its rating.
   *
   * @param h the head being neutralised
   * @param claimed hosts carrying an inverter limit of ours
   */
  neutralPayload(h, claimed) {
    const releaseIs = claimed.some((x) => (0, import_values.hostKey)(x) === (0, import_values.hostKey)(h.host)) && h.firstPollDone === true;
    return {
      releaseIs,
      payload: releaseIs ? { GS: 0, IS: Math.round(Math.abs(h.maxPower)) } : { GS: 0 }
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
  async neutralizeAllGs(reason = "controller shutdown") {
    const isOwned = await this.isOwnedHosts();
    const released = [];
    const results = await Promise.all(
      this.heads.map(async (h) => {
        const { payload, releaseIs } = this.neutralPayload(h, isOwned);
        try {
          await h.api.write(payload);
          this.log.info(
            `Head ${h.index}: GS neutralized to 0${releaseIs ? ", IS released to maximum" : ""} (${reason}).`
          );
          if (releaseIs) {
            released.push(h.host);
          }
          return true;
        } catch (e) {
          this.log.warn(`Head ${h.index}: could not neutralize GS: ${(0, import_values.errMsg)(e)}`);
          return false;
        }
      })
    );
    if (released.length) {
      await this.setIsOwnedHosts(isOwned.filter((x) => !released.some((host) => (0, import_values.hostKey)(host) === (0, import_values.hostKey)(x))));
    }
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
  /**
   * Neutralises heads a previous run owned that are no longer configured.
   *
   * Runs on *both* startup paths. The controller path is the one that matters most —
   * dropping a head from the configuration and staying in controller mode is the
   * normal thing to do — and it is also the path that overwrites the recorded host
   * list, so whatever is not handled here is lost for good.
   *
   * @returns hosts that could not be reached and therefore stay on the record
   */
  async cleanupRemovedHosts() {
    if (!await this.isGsOwnedByAdapter()) {
      return [];
    }
    const current = new Set(this.heads.map((h) => (0, import_values.hostKey)(h.host)));
    const gone = (await this.gsOwnedHosts()).filter((host) => !current.has((0, import_values.hostKey)(host)));
    if (!gone.length) {
      return [];
    }
    this.log.info(
      `${gone.length} head(s) from an earlier run are no longer configured (${gone.join(", ")}) but may still carry a setpoint \u2014 neutralising them.`
    );
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    const failed = [];
    await Promise.all(
      gone.map(async (host) => {
        const api = this.foreignApi(host, timeoutMs);
        try {
          await api.write({ GS: 0 });
          this.log.info(`Head ${host}: GS neutralized to 0 (removed from configuration).`);
          this.gsCleanupDone.add((0, import_values.hostKey)(host));
        } catch (e) {
          this.log.warn(`Head ${host}: could not be neutralised: ${(0, import_values.errMsg)(e)}`);
          this.foreignRetryFailures.set((0, import_values.hostKey)(host), 1);
          failed.push(host);
        }
      })
    );
    return failed;
  }
  async resumeGsOwnership() {
    if (!await this.isGsOwnedByAdapter()) {
      return;
    }
    const hosts = await this.gsOwnedHosts();
    const current = new Set(this.heads.map((h) => (0, import_values.hostKey)(h.host)));
    const gone = hosts.filter((host) => !current.has((0, import_values.hostKey)(host)));
    this.log.info(
      `A grid setpoint from an earlier run may still be active on ${hosts.length} head(s) \u2014 neutralising them.`
    );
    if (gone.length) {
      this.log.info(
        `Including ${gone.length} head(s) no longer configured here (${gone.join(", ")}); they were left with a setpoint and are cleaned up regardless.`
      );
    }
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    const results = await Promise.all(
      hosts.map(async (host) => {
        var _a;
        const known = this.heads.find((x) => (0, import_values.hostKey)(x.host) === (0, import_values.hostKey)(host));
        const api = (_a = known == null ? void 0 : known.api) != null ? _a : this.foreignApi(host, timeoutMs);
        try {
          await api.write({ GS: 0 });
          this.log.info(`Head ${host}: GS neutralized to 0 (ownership cleanup).`);
          this.gsCleanupDone.add((0, import_values.hostKey)(host));
          return true;
        } catch (e) {
          this.log.warn(`Head ${host}: ownership cleanup failed: ${(0, import_values.errMsg)(e)}`);
          this.foreignRetryFailures.set((0, import_values.hostKey)(host), 1);
          return false;
        }
      })
    );
    if (results.every(Boolean)) {
      await this.setGsOwnedByAdapter(false);
    } else {
      this.gsCleanupPending = true;
      this.gsCleanupHosts = hosts;
      this.log.warn("Not every head could be neutralised yet \u2014 retrying as they answer.");
    }
  }
  /**
   * Retries the ownership cleanup for one head that has just answered a poll.
   *
   * @param h the head that just delivered a successful poll
   */
  /**
   * Reports a failed retry on a host that has no poll of its own.
   *
   * The same shape three times over: the first failure is worth a warning, the
   * repeats are not, and after ten minutes the operator needs to hear that this host
   * is holding a record open and how to close it. Written out at each call site, the
   * third one was forgotten and produced a warning a minute, indefinitely.
   *
   * @param book per-host failure counts for this job
   * @param host the host that did not answer
   * @param what the job, named for the log
   * @param stateId the record the operator can strike the host from
   * @param detail the underlying error message
   */
  reportRetryFailure(book, host, what, stateId, detail) {
    var _a;
    const failures = ((_a = book.get((0, import_values.hostKey)(host))) != null ? _a : 0) + 1;
    book.set((0, import_values.hostKey)(host), failures);
    if (failures === 1) {
      this.log.warn(`Head ${host}: ${what} failed (${detail}) \u2014 keeping it on record and retrying.`);
    } else if (failures === FOREIGN_RETRY_WARN_AFTER) {
      const minutes = Math.round(FOREIGN_RETRY_WARN_AFTER * FOREIGN_RETRY_INTERVAL_MS / 6e4);
      this.log.warn(
        `Head ${host} has not answered for ${minutes} minutes and still holds ${stateId} open. The adapter keeps trying, because what it cannot confirm it must not forget. If that device is gone for good, remove its address from ${stateId}.`
      );
    } else {
      this.log.debug(`Head ${host}: ${what} failed again: ${detail}`);
    }
  }
  /**
   * Retries hosts from the outstanding cleanup that have no poll of their own.
   *
   * A head that is no longer configured is never polled, so the ordinary retry never
   * reaches it and the ownership flag would stay set forever. This rides along on any
   * other head's poll, throttled so an unreachable host does not add a request per
   * poll cycle.
   */
  async retryForeignCleanup() {
    if (this.stopping) {
      return;
    }
    const configured = new Set(this.heads.map((x) => (0, import_values.hostKey)(x.host)));
    const candidates = this.gsCleanupPending ? this.gsCleanupHosts : this.pendingForeignHosts;
    const stillRecorded = new Set((await this.gsOwnedHosts()).map(import_values.hostKey));
    const pending = candidates.filter(
      (host) => !configured.has((0, import_values.hostKey)(host)) && !this.gsCleanupDone.has((0, import_values.hostKey)(host)) && stillRecorded.has((0, import_values.hostKey)(host))
    );
    if (!pending.length || Date.now() - this.lastForeignRetry < FOREIGN_RETRY_INTERVAL_MS) {
      return;
    }
    this.lastForeignRetry = Date.now();
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    await Promise.all(
      pending.map(async (host) => {
        const api = this.foreignApi(host, timeoutMs);
        try {
          await api.write({ GS: 0 });
          this.log.info(`Head ${host}: GS neutralized to 0 (cleanup retry, no longer configured).`);
          this.gsCleanupDone.add((0, import_values.hostKey)(host));
          this.foreignRetryFailures.delete((0, import_values.hostKey)(host));
        } catch (e) {
          this.reportRetryFailure(
            this.foreignRetryFailures,
            host,
            "neutralising a grid setpoint from an earlier run",
            "info.gsOwnedHosts",
            (0, import_values.errMsg)(e)
          );
        }
      })
    );
    this.releaseForeignApis();
    this.pendingForeignHosts = this.pendingForeignHosts.filter((h) => !this.gsCleanupDone.has((0, import_values.hostKey)(h)));
    if (this.gsCleanupPending) {
      await this.finishCleanupIfDone();
    }
  }
  /**
   * Retries releasing meter bindings on hosts that have no poll of their own.
   *
   * A device head 1 no longer points at is never polled, so the off-mode guard never
   * reaches it while it keeps regulating itself from the meter this adapter bound.
   * Rides along on any other head's poll, on its own throttle.
   */
  /**
   * Retries handing the inverter limit back on hosts that have no poll of their own.
   *
   * Without this the comment on releaseForeignIs() was a promise the code did not
   * keep: a removed head that was unreachable at startup kept its throttled limit
   * until the next adapter start, which may be weeks away.
   */
  async retryForeignIsRelease() {
    if (this.stopping) {
      return;
    }
    const claimed = await this.isOwnedHosts();
    if (!claimed.length || Date.now() - this.lastIsRetry < FOREIGN_RETRY_INTERVAL_MS) {
      return;
    }
    const configured = new Set(this.heads.map((x) => (0, import_values.hostKey)(x.host)));
    const gone = claimed.filter((host) => !configured.has((0, import_values.hostKey)(host)));
    if (!gone.length) {
      return;
    }
    this.lastIsRetry = Date.now();
    await this.releaseForeignIs(gone);
    this.releaseForeignApis();
  }
  async retryForeignMeterRelease() {
    var _a, _b;
    if (this.stopping) {
      return;
    }
    const keep = this.controlMode === "device" ? (_b = (_a = this.heads[0]) == null ? void 0 : _a.host) != null ? _b : "" : "";
    const bound = await this.meterBoundHosts();
    if (!bound.length || Date.now() - this.lastMeterRetry < FOREIGN_RETRY_INTERVAL_MS) {
      return;
    }
    const settled = new Set(this.heads.map((x) => (0, import_values.hostKey)(x.host)));
    if (keep) {
      settled.clear();
      settled.add((0, import_values.hostKey)(keep));
    }
    if (!bound.some((host) => !settled.has((0, import_values.hostKey)(host)))) {
      return;
    }
    this.lastMeterRetry = Date.now();
    await this.releaseMeterBindings(keep);
    this.releaseForeignApis();
  }
  /**
   * Picks up an inverter limit a previous run left throttled.
   *
   * Runs on every start, independently of the grid-setpoint cleanup: the two claims
   * end at different moments. GS is cleared the instant a zero lands, while IS can
   * only be handed back once the head's real maximum is known — so a run that ended
   * before the first poll leaves GS settled and IS still throttled. Reading the claim
   * off `controllerControlIs` instead meant that turning the option off made the
   * adapter forget a limit that was already sitting on the device, leaving the
   * inverter shut while the controller integrates against it.
   */
  async resumeIsOwnership() {
    const claimed = await this.isOwnedHosts();
    if (!claimed.length) {
      return;
    }
    const steering = this.controlMode === "controller" && !!this.config.controllerControlIs;
    const configured = new Map(this.heads.map((h) => [(0, import_values.hostKey)(h.host), h]));
    const unconfigured = claimed.filter((host) => !configured.has((0, import_values.hostKey)(host)));
    for (const host of claimed) {
      const known = configured.get((0, import_values.hostKey)(host));
      if (known && !steering) {
        this.isReleasePending.add((0, import_values.hostKey)(known.host));
      }
    }
    if (unconfigured.length) {
      this.log.info(
        `An inverter limit from an earlier run may still throttle ${unconfigured.length} head(s) that are no longer configured (${unconfigured.join(", ")}) \u2014 reading their model to hand it back.`
      );
      await this.releaseForeignIs(unconfigured);
    }
    if (steering) {
      await this.claimIsForCurrentHeads();
    }
  }
  /**
   * Hands the inverter limit back on hosts that are not configured any more.
   *
   * Their model is unknown, and writing a guessed maximum would hand a 500 three
   * times its rating — so the device is asked first. A host that does not answer
   * stays on the claim and is retried from the poll loop.
   *
   * @param hosts the unconfigured hosts still carrying a limit of ours
   */
  async releaseForeignIs(hosts) {
    if (this.stopping) {
      return;
    }
    const timeoutMs = Math.max(1e3, Math.round((0, import_states.cfgNum)(this.config.requestTimeout, 8e3)));
    await Promise.all(
      hosts.map(async (host) => {
        var _a;
        const api = this.foreignApi(host, timeoutMs);
        try {
          const data = (await api.read()).reported;
          if (this.stopping) {
            return;
          }
          const max = Math.round(Math.abs((_a = (0, import_values.num)(data.MG)) != null ? _a : (0, import_values.fallbackMaxPower)(data)));
          await api.write({ IS: max });
          this.isRetryFailures.delete((0, import_values.hostKey)(host));
          this.log.info(`Head ${host}: inverter limit released to ${max} W (no longer configured).`);
          await this.clearIsClaim(host);
        } catch (e) {
          this.reportRetryFailure(
            this.isRetryFailures,
            host,
            "releasing the inverter limit",
            "info.isOwnedHosts",
            (0, import_values.errMsg)(e)
          );
        }
      })
    );
  }
  /**
   * Hands the inverter limit back once a head's real maximum is known.
   *
   * The startup cleanup deliberately skips IS while `maxPower` is still the
   * constructor default — writing 2400 W to a 500 would be worse than writing
   * nothing. This finishes the job on the first poll that delivers the true value.
   *
   * @param h the head that has just been polled successfully
   */
  async finishIsRelease(h) {
    if (this.stopping || !this.isReleasePending.has((0, import_values.hostKey)(h.host)) || !h.firstPollDone) {
      return;
    }
    this.isReleasePending.delete((0, import_values.hostKey)(h.host));
    try {
      await h.api.write({ IS: Math.round(Math.abs(h.maxPower)) });
      await this.clearIsClaim(h.host);
      this.log.info(`Head ${h.index}: inverter limit released to ${Math.round(Math.abs(h.maxPower))} W.`);
    } catch (e) {
      this.isReleasePending.add((0, import_values.hostKey)(h.host));
      this.log.debug(`Head ${h.index}: could not release the inverter limit yet: ${(0, import_values.errMsg)(e)}`);
    }
  }
  /** Clears the ownership flag once every host of the outstanding job is done. */
  async finishCleanupIfDone() {
    if (this.gsCleanupHosts.every((host) => this.gsCleanupDone.has((0, import_values.hostKey)(host)))) {
      this.gsCleanupPending = false;
      await this.setGsOwnedByAdapter(false);
      this.log.info("All heads neutralised \u2014 the adapter no longer holds a grid setpoint.");
    }
  }
  async retryGsCleanup(h) {
    if (this.stopping) {
      return;
    }
    await this.retryForeignCleanup();
    if (!this.gsCleanupPending || this.controlMode === "controller" || this.gsCleanupDone.has((0, import_values.hostKey)(h.host)) || // Only heads that are actually part of the outstanding job. Without this a
    // head that was never on the list gets neutralised just because it happens to
    // be polling, while the heads the job is about are never reached.
    !this.gsCleanupHosts.some((x) => (0, import_values.hostKey)(x) === (0, import_values.hostKey)(h.host))) {
      return;
    }
    try {
      const claimed = await this.isOwnedHosts();
      if (this.stopping) {
        return;
      }
      const { payload, releaseIs } = this.neutralPayload(h, claimed);
      await h.api.write(payload);
      this.log.info(`Head ${h.index}: GS neutralized to 0 (ownership cleanup, retry).`);
      this.gsCleanupDone.add((0, import_values.hostKey)(h.host));
      if (releaseIs) {
        await this.clearIsClaim(h.host);
      }
      await this.finishCleanupIfDone();
    } catch (e) {
      this.log.debug(`Head ${h.index}: ownership cleanup retry failed: ${(0, import_values.errMsg)(e)}`);
    }
  }
  /**
   * Starts the multi-head self-consumption controller (controller mode).
   *
   * @param inheritedOwnership true when a previous run may have left setpoints on the
   * heads, so the controller starts out responsible for them
   */
  async setupController(inheritedOwnership = false) {
    this.gridStateId = (this.config.gridPowerStateId || "").trim();
    if (!this.gridStateId) {
      this.log.warn(
        "Controller mode selected but no grid-power source state configured \u2014 controller not started."
      );
      return;
    }
    const cfg = {
      // Adaptive tiers by default; missing key (pre-0.2.7 installs) means adaptive.
      adaptive: this.config.controllerAdaptive !== false,
      targetW: Math.max(-200, Math.min(200, (0, import_states.cfgNum)(this.config.controllerTargetW, 0))),
      gain: (0, import_states.cfgNum)(this.config.controllerGain, 0.3),
      deadBandW: Math.max(0, (0, import_states.cfgNum)(this.config.controllerDeadBandW, 20)),
      maxStepW: Math.max(0, (0, import_states.cfgNum)(this.config.controllerMaxStepW, 500)),
      minIntervalMs: Math.max(1e3, (0, import_states.cfgNum)(this.config.controllerMinIntervalMs, 5e3)),
      writeDeadBandW: Math.max(0, (0, import_states.cfgNum)(this.config.controllerWriteDeadBandW, 10)),
      meterStabilizationMs: Math.max(0, (0, import_states.cfgNum)(this.config.controllerMeterStabilizationMs, 0)),
      controlIs: !!this.config.controllerControlIs,
      isWriteDeadBandW: Math.max(1, (0, import_states.cfgNum)(this.config.controllerIsWriteDeadBandW, 10)),
      inverted: !!this.config.gridPowerInverted,
      warnSec: Math.max(5, (0, import_states.cfgNum)(this.config.watchdogWarnSec, 30)),
      failsafeSec: Math.max(10, (0, import_states.cfgNum)(this.config.watchdogFailsafeSec, 180))
    };
    const hooks = {
      getHeads: () => this.headStates(),
      writeGs: async (index, gs) => {
        const h = this.heads.find((x) => x.index === index);
        if (h) {
          await h.api.write({ GS: gs }, CONTROL_WRITE_TIMEOUT_MS);
        }
      },
      reflectGs: async (index, gs) => {
        const id = `heads.${index}.control.GS`;
        await this.setStateChangedAsync(id, gs, true);
        this.confirmedCache.set(id, gs);
      },
      writeIs: async (index, is) => {
        const h = this.heads.find((x) => x.index === index);
        if (h) {
          await h.api.write({ IS: is }, CONTROL_WRITE_TIMEOUT_MS);
        }
      },
      reflectIs: async (index, is) => {
        const id = `heads.${index}.control.IS`;
        await this.setStateChangedAsync(id, is, true);
        this.confirmedCache.set(id, is);
      }
    };
    this.controller = new import_controller.MultiHeadController(this, hooks, this.gridStateId, cfg);
    await this.subscribeForeignStatesAsync(this.gridStateId);
    if (inheritedOwnership) {
      this.controller.assumeCommanded(this.heads.map((h) => h.index));
    }
    await this.setGsOwnedByAdapter(true);
    if (this.config.controllerControlIs) {
      await this.claimIsForCurrentHeads();
    }
    await this.controller.start();
    this.log.info(
      `Self-consumption controller active on grid source "${this.gridStateId}" across ${this.heads.length} head(s).`
    );
  }
  /** Maps the current head runtime to the pure HeadState used by the controller and split. */
  headStates() {
    return this.heads.map((h) => {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      return {
        index: h.index,
        // Deliberately not h.online: that flips on the first missed poll, while a head
        // stays a live participant in the grid until several polls in a row have
        // failed. See CONTROL_DROP_AFTER_FAILURES.
        online: h.online || h.pollFailures < CONTROL_DROP_AFTER_FAILURES,
        gp: (_a = h.gp) != null ? _a : 0,
        // A head that answered without SoC must not be regulated on placeholders. socMin
        // included: substituting 0 would invent a floor the device never agreed to.
        controllable: h.soc !== void 0 && h.socMax !== void 0 && h.socMin !== void 0,
        soc: (_b = h.soc) != null ? _b : 0,
        socMin: (_c = h.socMin) != null ? _c : 0,
        socMax: (_d = h.socMax) != null ? _d : 100,
        maxPower: h.maxPower,
        lp: (_e = h.lp) != null ? _e : 0,
        pv: (_f = h.pv) != null ? _f : 0,
        // 5 % is the manufacturer default; assuming none would reintroduce the chatter.
        socHysteresisDischarge: (_g = h.socHysteresisDischarge) != null ? _g : 5,
        socHysteresisCharge: (_h = h.socHysteresisCharge) != null ? _h : 5
      };
    });
  }
}
if (require.main !== module) {
  module.exports = (options) => new Sunenergyxt500(options);
} else {
  (() => new Sunenergyxt500())();
}
//# sourceMappingURL=main.js.map
