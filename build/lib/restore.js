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
var restore_exports = {};
__export(restore_exports, {
  findDrift: () => findDrift,
  parseDesired: () => parseDesired
});
module.exports = __toCommonJS(restore_exports);
var import_values = require("./values");
function parseDesired(raw, allowed) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (allowed.has(field) && typeof value === "number" && Number.isFinite(value)) {
      out[field] = value;
    }
  }
  return out;
}
function findDrift(desired, reported) {
  const drift = {};
  for (const [field, want] of Object.entries(desired)) {
    if (!(field in reported)) {
      continue;
    }
    const have = (0, import_values.num)(reported[field]);
    if (have === void 0 || have !== want) {
      drift[field] = want;
    }
  }
  return drift;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  findDrift,
  parseDesired
});
//# sourceMappingURL=restore.js.map
