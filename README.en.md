![Logo](admin/sunenergyxt500.png)
# ioBroker.sunenergyxt500

[![NPM version](https://img.shields.io/npm/v/iobroker.sunenergyxt500.svg)](https://www.npmjs.com/package/iobroker.sunenergyxt500)
[![Downloads](https://img.shields.io/npm/dm/iobroker.sunenergyxt500.svg)](https://www.npmjs.com/package/iobroker.sunenergyxt500)
![Number of Installations](https://iobroker.live/badges/sunenergyxt500-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/sunenergyxt500-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.sunenergyxt500.png?downloads=true)](https://nodei.co/npm/iobroker.sunenergyxt500/)

**Tests:** ![Test and Release](https://github.com/Creekhail/ioBroker.sunenergyxt500/workflows/Test%20and%20Release/badge.svg)

## sunenergyxt500 adapter for ioBroker

Integration and self-consumption control for **SunEnergyXT 500 / 500 PRO** AC-coupled hybrid battery storage systems via the device's **local HTTP API** — no cloud account required.

## Language / Sprache

- [English](README.en.md) (default)
- [Deutsch](README.de.md)

## Features

* Polls the local API (`GET /read`) and mirrors all stable fields to states: SoC, battery/grid/load/PV power, per-MPPT current/voltage, daily energy counters, per-pack SoC, device/firmware info and meter status.
* Writable control fields (`POST /write`, confirmed by re-reading), matching the official integration's control surface except fields the API docs mark as *reserved*: grid setpoint `GS`, max feed-in `IS`, SoC limits `SI`/`SA`/`SO`, self-consumption mode `MM`, meter config `MD`, timezone `TZ`, restart `RT`, max grid output `MG`, the `LFB`/`LPS`/`PM` switches and local mode `LM` (⚠️ `LM=1` blocks cloud/app control until reset). Reserved fields (e.g. `PT`, `SI1`, `SA1`) are exposed read-only only.
* Two switchable **control modes**: an adapter-side self-consumption **controller** (writes `GS` from *any* ioBroker meter state, feed-forward + P, with watchdog/failsafe), or **device self-regulation** (binds a supported meter into the storage and lets the device control itself) — plus an **off** mode for pure monitoring.
* Connection indicator (`info.connection`) plus `info.lastUpdate` / `info.lastError`.
* The complete, unmodified `/read` response is kept in `info.rawResponse` (JSON), so any field the adapter does not map to a dedicated state can still be read from there.

## How this adapter works

This adapter controls the storage **locally**, without the manufacturer cloud. Self-consumption can be handled in **two mutually exclusive ways** — you pick one via the **Control mode** setting:

**Mode B — Adapter controller (default-recommended, works with any meter).** ioBroker reads the current grid power from **any state you point it at** (`gridPowerStateId`) and the adapter writes the grid setpoint `GS` (feed-forward + P correction, with a watchdog). The meter can be *anything* ioBroker supports — Shelly, Tasmota, a smart-meter/Modbus adapter — **including meters the storage cannot read itself**. You provide one state holding the **net grid power in watts** (`>0` = draw, `<0` = feed-in; enable *invert source sign* if reversed; for kW / split import-export / per-phase meters compute a clean net value in a small ioBroker state first). The adapter forces `MM=0` so the device executes `GS`, and the meter stays fully usable in ioBroker.

**Mode A — Device self-regulation (supported meters).** The adapter binds a supported meter **into the storage** (`MM=1` + `MD`) and lets the **device regulate itself** — the manufacturer's own self-consumption, which may react faster than an external loop. Only four meter types are supported (EcoTracker, Shelly 3EM, Shelly Pro 3EM, Tasmota) and the meter must be reachable by the storage on the LAN. The adapter does **not** write `GS` in this mode. The binding is just mDNS/HTTP polling, so the meter **stays usable in ioBroker** — unlike the manufacturer app's meter setup, which can reconfigure the meter and remove it from ioBroker; this adapter binds directly and avoids that.

**Off (default, monitoring only).** The adapter never writes `MM`/`MD`/`GS`; it only polls. You can still command `control.*` states manually.

In both control modes the adapter **owns `MM`**: on every poll it checks the device's `MM` against the chosen mode and re-asserts it (with a warning) if something else changed it — so a stray meter binding or an external script cannot silently disable control. Note: the device only executes a written `GS` when `MM=0`; with a meter bound (`MM=1`) it self-regulates and ignores `GS`.

**Local mode (`LM=1`) is required.** The device only serves its local HTTP API (`/read` / `/write`) when **local mode is enabled** — with it off, `/read` returns no data (confirmed on the tested firmware). Enabling local mode also switches off cloud/app remote control; consequently the manufacturer's phone app can no longer control the device.

## Requirements

* A SunEnergyXT 500 (`PK=1`, 800 W) or 500 PRO (`PK=2`, 2400 W) reachable in the local network.
* **Local mode (`LM=1`) enabled** on the device — required for the local HTTP API to deliver values (see *How this adapter works*). This also disables cloud/app remote control.
* A meter, depending on the control mode: for **Mode B** (adapter controller) any meter whose grid power is available as an **ioBroker state**; for **Mode A** (device self-regulation) one of the four supported meters (EcoTracker, Shelly 3EM, Shelly Pro 3EM, Tasmota) reachable by the storage on the LAN. Not needed in *Off* mode.

## Installation

1. In ioBroker admin open **Adapters**, search for **sunenergyxt500** and install it.
2. After installation an instance `sunenergyxt500.0` is created. Open its settings and enter the **device IP / hostname**. Leave the **Control mode** at *Off* for pure monitoring.
3. Save & close — the adapter starts polling and fills the object tree under `sunenergyxt500.0.*`.

## Configuration

**Connection**
* **Device IP / hostname** — local address of the storage system.
* **Poll interval (s)** — how often `/read` is queried (default 5 s).
* **Request timeout (ms)** — HTTP timeout (default 8000 ms).

**Control** — pick a **Control mode**:

*Off* (default) — monitoring only; the adapter never writes `MM`/`MD`/`GS`.

*Adapter controller* (Mode B) — fields:
* **Grid-power source state** — a foreign state holding your house meter's grid power. Convention: `>0` = grid draw, `<0` = feed-in. Enable **Invert source sign** if your meter uses the opposite convention.
* **Gain** (default 0.3), **Dead band** (W), **Min. write interval** (ms), **Max. power** (W, 2400 for the Pro / 800 for the Standard).
* **Watchdog warn / failsafe (s)** — if the grid source goes stale, the controller logs a warning and finally forces `GS=0` (safe neutral) until the source recovers. Watchdog telemetry is exposed under `controller.*`.

The controller reads the device's actual grid power (`GP`) back before each correction, which provides natural anti-windup when the device internally limits (e.g. by SoC).

*Device self-regulation* (Mode A) — fields:
* **Meter type** — EcoTracker / Shelly 3EM / Shelly Pro 3EM / Tasmota.
* **Meter SN / IP** — the serial number for Shelly/Tasmota (resolved via mDNS), or the LAN IP for EcoTracker (direct). For Tasmota use the SN prefix without the last 4 characters and set the **power key** matching your energy-monitor subtype.

The adapter binds the meter (`MM=1` + `MD`) and the device regulates itself; the adapter does not write `GS`. The bound meter stays usable in ioBroker.

> **Safety:** In *Off* mode the adapter is read-only — it only polls `/read` and never writes unless you command a `control.*` state. In a control mode the adapter **enforces `MM`** for that mode and re-asserts it if changed externally; do **not** run a second `GS` writer at the same time (your own script, or the device's `MM` with a different meter), otherwise they fight over the battery.

## Sign conventions

* `GP` (grid power): `>0` = feed-in, `<0` = draw — **opposite to a Shelly meter** (`api.GP ≈ −shelly.gridPower`).
* `PB` (battery power): `>0` = charging, `<0` = discharging.
* `GS` (grid setpoint): `>0` = feed-in/discharge, `<0` = grid charging (±2400 W on the Pro, 10 W steps).

## Object tree

States are grouped into thematic channels. The **leaf of each object id is the device's API field code** (the entity id from the official field reference), and the bilingual object name describes it — so the tree maps 1:1 to the device's documented fields.

| Channel | Contents |
|---|---|
| `battery.*` | SoC (`SC`), battery power (`BP`), per-pack SoC (`SC0`–`SC5`), online packs (`ON`), SoC hysteresis (`SI1`/`SA1`) |
| `grid.*` | grid power (`GP`), daily charge/feed-in energy (`GD1`/`GD2`) |
| `load.*` | load power (`LP`), daily off-grid load energy (`LD`) |
| `pv.*` | total PV (`PV`) and per-MPPT power/current/voltage (`mppt1`–`mppt4`) |
| `system.*` | total input/output power (`IW`/`OP`) |
| `device.*` | type/model/serial/status; `device.network.*` (IP, port, Wi-Fi); `device.firmware.*` (`ES`/`AS`/`DS` software, `EH`/`AH`/`DH` hardware, `BS0`–`BS5` BMS) |
| `meter.*` | external meter status (`MS`) |
| `ups.*` | UPS mode / grid-charge / bypass (`UO`/`UG`/`FP`) |
| `fault.*` | fault bitmasks (`TF`/`EF`/`DF1`/`DF2`/`AF1`/`AF2`/`BF`) — only populated while a fault is active |
| `control.*` | all **writable** fields (see below) |
| `controller.*` | self-consumption controller telemetry |
| `info.*` | `connection`, `lastUpdate`, `lastError`, `rawResponse` (the full raw `/read`), device `timestamp` |

### Writable controls (`control.*`)

By ioBroker convention all writable fields live under `control.*`. Because that flattens their topic, this table shows what each one relates to:

| Object | Field | Relates to | Description |
|---|---|---|---|
| `control.GS` | GS | grid | Grid power setpoint (`>0` feed-in / `<0` grid charge) |
| `control.IS` | IS | grid | Max. grid feed-in / inverter output limit |
| `control.MG` | MG | grid | Max. grid-tied output power |
| `control.SI` | SI | battery | Min. discharge SoC (grid mode) |
| `control.SA` | SA | battery | Max. charge SoC (grid mode) |
| `control.SO` | SO | battery | Min. discharge SoC (off-grid mode) |
| `control.MM` | MM | mode | Local zero feed-in / self-consumption mode (coupled with `MD`) |
| `control.MD` | MD | meter | Meter connection JSON (coupled with `MM`) |
| `control.LM` | LM | mode | Local mode (⚠️ `1` blocks cloud/app control) |
| `control.LFB` | LFB | mode | Load priority switch |
| `control.LPS` | LPS | mode | Off-grid output switch |
| `control.PM` | PM | mode | Parallel mode |
| `control.TZ` | TZ | device | POSIX timezone |
| `control.RT` | RT | device | Restart device (button) |

> Tip: in ioBroker admin you can also filter the object list by the *writable* flag to find all controls at once.

`device.PK` is derived from `DevType` on firmware that no longer reports `PK`. Reserved fields (`PT`, `SI1`, `SA1`) are exposed read-only. Fields the manufacturer dropped (`PD`, `UP`) or that are doc-only artefacts (`WT`, `BN`) are not exposed; anything unmapped is still available in `info.rawResponse`.

## Manual meter / mode fields (MM / MD)

`MM`/`MD` are the device's own meter-based self-consumption. When you select a **Control mode**, the adapter manages them for you (Mode A sets `MM=1` + `MD`; Mode B forces `MM=0`), and its guard re-asserts the mode-appropriate `MM` on the next poll — so any manual change in a control mode is temporary.

The raw fields stay writable for expert/manual use (e.g. in *Off* mode). They follow the official coupling: turning `MM` off also clears `MD`, and writing `MD` enables `MM` (non-empty) or disables it (empty). The `MD` JSON formats for the four supported meters are in the device's local API reference; in *Device self-regulation* mode the adapter builds them for you from the meter type and SN/IP.

## Limitations

* **Single storage head only.** Each adapter instance monitors and controls one SunEnergyXT head (via its own IP); coordinated control of multiple heads is not supported.
* Daily energy counters (`GD1`/`GD2`/`LD`) are raw **Wh**, not kWh.
* `MD` and `TZ` take effect immediately but are not guaranteed to be echoed back verbatim by the device — confirm by effect, not by echo.
* **PV inputs are untested with hardware** (the reference installation runs without PV modules, so `PV1–4` are always 0). The integration and controller are PV-agnostic and complete, but PV firmware edge cases (e.g. battery full + PV surplus, UPS/bypass fields `FP`/`UG`) are unverified — feedback welcome.

## Troubleshooting

* **`info.connection` stays `false` / no data:** first make sure **local mode (`LM=1`)** is enabled on the device — without it the local API returns no values. Then verify that `http://<device-ip>/read` is reachable from the ioBroker host (test with a browser or `curl`).
* **Nothing is being controlled:** check the **Control mode** — *Off* never writes. In *Adapter controller* set a valid **grid-power source state**; in *Device self-regulation* set a supported **meter type** and **SN/IP**.
* **Device ignores `GS` / battery does not react:** the device only executes a written `GS` when `MM=0`. In *Adapter controller* mode the adapter enforces this; if you write `GS` manually, make sure no meter is bound (`MM=0`). With a meter bound (`MM=1`) the device self-regulates and ignores `GS`.
* **Two controllers fight over the battery:** run only one. The adapter enforces `MM` for the selected mode — disable any external `GS` script (or the device's own `MM` with a different meter) before using a control mode.
* **Some states stay empty (`0` / `""`):** the device only returns the fields its firmware/topology actually provides (e.g. extra packs `SC2`–`SC5`, or fault bitmasks only during a fault). The complete raw response is always available in `info.rawResponse`.

## Changelog

The changelog is maintained in the main [README.md](README.md#changelog).

## License
MIT License

Copyright (c) 2026 Marcus Bortel (Creekhail)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
