"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var api_exports = {};
__export(api_exports, {
  SunEnergyXtApi: () => SunEnergyXtApi
});
module.exports = __toCommonJS(api_exports);
var http = __toESM(require("node:http"));
var import_node_url = require("node:url");
const MAX_RESPONSE_BYTES = 512 * 1024;
class SunEnergyXtApi {
  /**
   * @param host - device IP or hostname (with or without scheme)
   * @param timeoutMs - request timeout in milliseconds
   * @param timers - adapter instance supplying the managed timer functions
   */
  constructor(host, timeoutMs, timers) {
    this.timeoutMs = timeoutMs;
    this.timers = timers;
    const trimmed = (host || "").trim().replace(/\/+$/, "");
    this.baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    this.agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  }
  baseUrl;
  /**
   * A dedicated connection pool per head instead of Node's global agent:
   *
   * - `keepAlive: false` makes every request send `Connection: close` and tears the
   *   socket down afterwards. The global agent keeps a socket open for 5 s, which at
   *   a 5 s poll means permanently — and the ESP32 in the head has a very small
   *   socket table it cannot reclaim if the close is lost on a weak Wi-Fi link.
   * - `maxSockets: 1` serializes this head's requests: a control write is queued
   *   behind a running poll instead of opening a second parallel connection.
   */
  agent;
  /** Closes all sockets of this head's pool (adapter unload). */
  destroy() {
    this.agent.destroy();
  }
  /** Reads the current device snapshot (decoded `state.reported`) plus the original body. */
  async read() {
    const body = await this.request("GET", "/read");
    const parsed = JSON.parse(body);
    if (!isPlainObject(parsed)) {
      throw new Error("Unexpected /read response structure");
    }
    if ("state" in parsed) {
      const state = parsed.state;
      const reported = isPlainObject(state) ? state.reported : void 0;
      if (!isPlainObject(reported)) {
        throw new Error("Unexpected /read response structure");
      }
      return { reported, body };
    }
    return { reported: parsed, body };
  }
  /**
   * Writes one or more target fields partially under `state`.
   * Resolves on HTTP 2xx; the caller must confirm the effect via read().
   *
   * @param fields - map of API field name to value
   * @param timeoutMs - deadline for this write; defaults to the configured request
   * timeout. Regulation writes pass a shorter one, because a setpoint that takes
   * longer than a control cycle to arrive is stale by the time it lands.
   */
  async write(fields, timeoutMs) {
    await this.request("POST", "/write", JSON.stringify({ state: fields }), timeoutMs);
  }
  /**
   * Arms the request deadline and returns a canceller.
   *
   * Prefers the adapter's managed timer so the timeout is cleaned up with the
   * instance. That timer refuses to start once ioBroker has begun shutting the
   * adapter down, though — and the unload path still issues writes (neutralising the
   * heads). Falling back to a plain timer there keeps those last requests bounded
   * instead of letting them hang until the process is killed.
   *
   * @param onDeadline invoked when the timeout expires
   * @param timeoutMs deadline for this request
   */
  armDeadline(onDeadline, timeoutMs) {
    const managed = this.timers.setTimeout(onDeadline, timeoutMs);
    if (managed !== void 0) {
      return () => this.timers.clearTimeout(managed);
    }
    const plain = setTimeout(onDeadline, timeoutMs);
    return () => clearTimeout(plain);
  }
  request(method, path, payload, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new import_node_url.URL(path, this.baseUrl);
      const headers = { Connection: "close" };
      if (payload !== void 0) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      let settled = false;
      const pending = {};
      const settle = (err, data) => {
        var _a;
        if (settled) {
          return;
        }
        settled = true;
        (_a = pending.clear) == null ? void 0 : _a.call(pending);
        if (err) {
          reject(err);
        } else {
          resolve(data != null ? data : "");
        }
      };
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method,
          headers,
          agent: this.agent
        },
        (res) => {
          let data = "";
          let ended = false;
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("Response too large"));
            }
          });
          res.on("end", () => {
            var _a;
            ended = true;
            const status = (_a = res.statusCode) != null ? _a : 0;
            if (status < 200 || status >= 300) {
              settle(new Error(`HTTP ${status}`));
              return;
            }
            settle(void 0, data);
          });
          res.on("error", (e) => settle(e));
          res.on("close", () => {
            if (!ended) {
              settle(new Error("Response closed before it finished"));
            }
          });
        }
      );
      pending.clear = this.armDeadline(() => {
        settle(new Error("Timeout"));
        req.destroy();
      }, timeoutMs);
      req.on("error", (e) => settle(e));
      if (payload !== void 0) {
        req.write(payload);
      }
      req.end();
    });
  }
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SunEnergyXtApi
});
//# sourceMappingURL=api.js.map
