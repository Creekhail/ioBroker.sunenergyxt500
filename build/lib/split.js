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
var split_exports = {};
__export(split_exports, {
  computeTotalTarget: () => computeTotalTarget,
  splitTarget: () => splitTarget
});
module.exports = __toCommonJS(split_exports);
function computeTotalTarget(totalGp, gridPower, gain, sumMaxPower) {
  const limit = Math.abs(sumMaxPower);
  return clamp(Math.round(totalGp + gain * gridPower), -limit, limit);
}
function splitTarget(totalTarget, heads) {
  const result = new Map(heads.map((h) => [h.index, 0]));
  const charging = totalTarget < 0;
  const eligible = (h) => {
    if (!h.online || Math.abs(h.maxPower) <= 0) {
      return false;
    }
    return charging ? h.soc < h.socMax : h.soc > h.socMin;
  };
  const cap = (h) => charging ? -Math.abs(h.maxPower) : Math.abs(h.maxPower);
  let pool = heads.filter(eligible);
  let fixedSum = 0;
  for (let pass = 0; pass <= heads.length && pool.length > 0; pass++) {
    const share = (totalTarget - fixedSum) / pool.length;
    const newlyFixed = [];
    for (const h of pool) {
      if (Math.abs(share) >= Math.abs(cap(h))) {
        result.set(h.index, cap(h));
        newlyFixed.push(h);
      } else {
        result.set(h.index, share);
      }
    }
    if (newlyFixed.length === 0) {
      break;
    }
    for (const h of newlyFixed) {
      fixedSum += cap(h);
    }
    pool = pool.filter((h) => !newlyFixed.includes(h));
  }
  return heads.map((h) => {
    var _a;
    return { index: h.index, gs: Math.round((_a = result.get(h.index)) != null ? _a : 0) };
  });
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeTotalTarget,
  splitTarget
});
//# sourceMappingURL=split.js.map
