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
  computeIsTarget: () => computeIsTarget,
  computeTotalTarget: () => computeTotalTarget,
  inChargeBand: () => inChargeBand,
  inDischargeBand: () => inDischargeBand,
  splitTarget: () => splitTarget
});
module.exports = __toCommonJS(split_exports);
function computeTotalTarget(totalGp, gridPower, gain, sumMaxPower) {
  const limit = Math.abs(sumMaxPower);
  return clamp(Math.round(totalGp + gain * gridPower), -limit, limit);
}
function inDischargeBand(h) {
  const band = Math.max(0, h.socHysteresisDischarge);
  return band > 0 && h.soc > h.socMin && h.soc <= h.socMin + band;
}
function inChargeBand(h) {
  const band = Math.max(0, h.socHysteresisCharge);
  return band > 0 && h.soc < h.socMax && h.soc >= h.socMax - band;
}
function splitTarget(totalTarget, heads, resuming = /* @__PURE__ */ new Set()) {
  const result = new Map(heads.map((h) => [h.index, 0]));
  const charging = totalTarget < 0;
  const eligible = (h) => {
    if (!h.online || !h.controllable || Math.abs(h.maxPower) <= 0) {
      return false;
    }
    if (resuming.has(h.index) && (charging ? inChargeBand(h) : inDischargeBand(h))) {
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
    return {
      index: h.index,
      gs: Math.round((_a = result.get(h.index)) != null ? _a : 0),
      // Only heads that are online and capable but blocked by SoC count as limited.
      socLimited: totalTarget !== 0 && h.online && h.controllable && Math.abs(h.maxPower) > 0 && !(charging ? h.soc < h.socMax : h.soc > h.socMin)
    };
  });
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function computeIsTarget(head, gs) {
  const loadDemand = Math.max(head.lp, 0);
  let target = Math.max(gs, 0) + loadDemand;
  if (head.soc <= head.socMin) {
    target = Math.min(target, Math.max(head.pv, 0));
  }
  return Math.round(clamp(target, 0, Math.abs(head.maxPower)));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeIsTarget,
  computeTotalTarget,
  inChargeBand,
  inDischargeBand,
  splitTarget
});
//# sourceMappingURL=split.js.map
