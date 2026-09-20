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
var values_exports = {};
__export(values_exports, {
  asString: () => asString,
  errMsg: () => errMsg,
  fallbackMaxPower: () => fallbackMaxPower,
  hostKey: () => hostKey,
  num: () => num
});
module.exports = __toCommonJS(values_exports);
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
function fallbackMaxPower(data) {
  const pk = num(data.PK);
  if (pk === 1) {
    return 800;
  }
  if (pk === 2) {
    return 2400;
  }
  const devType = typeof data.DevType === "string" ? data.DevType : "";
  if (devType && !/pro/i.test(devType)) {
    return 800;
  }
  return 2400;
}
function num(value) {
  if (value === null || value === void 0 || value === "" || typeof value === "boolean") {
    return void 0;
  }
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
function hostKey(host) {
  return (host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  asString,
  errMsg,
  fallbackMaxPower,
  hostKey,
  num
});
//# sourceMappingURL=values.js.map
