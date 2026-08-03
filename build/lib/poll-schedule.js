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
var poll_schedule_exports = {};
__export(poll_schedule_exports, {
  POLL_BACKOFF_MAX_MS: () => POLL_BACKOFF_MAX_MS,
  POLL_BACKOFF_MAX_STEPS: () => POLL_BACKOFF_MAX_STEPS,
  POLL_STAGGER_MAX_MS: () => POLL_STAGGER_MAX_MS,
  pollBackoffMs: () => pollBackoffMs,
  pollStaggerMs: () => pollStaggerMs
});
module.exports = __toCommonJS(poll_schedule_exports);
const POLL_STAGGER_MAX_MS = 1e3;
const POLL_BACKOFF_MAX_MS = 6e4;
const POLL_BACKOFF_MAX_STEPS = 4;
function pollStaggerMs(index, count, intervalMs) {
  const step = Math.min(POLL_STAGGER_MAX_MS, Math.floor(intervalMs / Math.max(1, count)));
  return Math.max(0, index - 1) * step;
}
function pollBackoffMs(intervalMs, failures) {
  if (failures <= 0) {
    return intervalMs;
  }
  const factor = 2 ** Math.min(failures - 1, POLL_BACKOFF_MAX_STEPS);
  return Math.min(intervalMs * factor, Math.max(intervalMs, POLL_BACKOFF_MAX_MS));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  POLL_BACKOFF_MAX_MS,
  POLL_BACKOFF_MAX_STEPS,
  POLL_STAGGER_MAX_MS,
  pollBackoffMs,
  pollStaggerMs
});
//# sourceMappingURL=poll-schedule.js.map
