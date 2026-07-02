/*
 * State definitions for the SunEnergyXT 500 adapter.
 *
 * Field semantics are taken from the local API reference (SunEnergyXT_API.de.md)
 * and the original ioBroker poller script. Sign conventions:
 *   GP  > 0 = feed-in to grid,  < 0 = grid draw   (opposite to a Shelly meter!)
 *   BP  > 0 = charging,         < 0 = discharging
 *   GS  > 0 = feed-in/discharge,< 0 = grid charging  (±2400 W on the 500 Pro)
 */

import type { ReportedState } from './api';

/** Bilingual object name (English + German), used as ioBroker common.name. */
export interface LocalizedName {
	en: string;
	de: string;
}

export interface StateDef {
	/** Relative object id within the adapter namespace */
	id: string;
	/** API field name in /read (state.reported) */
	field: string;
	role: string;
	type: ioBroker.CommonType;
	/** Bilingual display name */
	name: LocalizedName;
	unit?: string;
	/** Number of decimals to keep for numeric values (default 0) */
	decimals?: number;
	/** Factor applied to the raw device value (e.g. 0.1 for II/VP which report tenths) */
	scale?: number;
	/** Optional enum labels for numeric status codes (ioBroker common.states) */
	states?: Record<number, string>;
	/** Whether the state is writable (control field sent back via /write) */
	write?: boolean;
	/**
	 * If set, the value is computed from the whole reported object instead of a
	 * single field (e.g. PK is derived from DevType on newer firmware).
	 */
	derive?: (data: ReportedState) => number | string | null;
}

/** Read-only measurement states mirrored from /read. */
export const measurementDefs: StateDef[] = [
	// Primary values
	{
		id: 'battery.SC',
		field: 'SC',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'Total state of charge', de: 'Gesamt-Ladezustand' },
	},
	{
		// The doc names this field "PB", but real firmware reports it as "BP" (+charge / -discharge).
		id: 'battery.BP',
		field: 'BP',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Battery power (+charge / -discharge)', de: 'Batterieleistung (+Laden / -Entladen)' },
	},
	// Grid / load / PV
	{
		id: 'grid.GP',
		field: 'GP',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Grid power (+feed-in / -draw)', de: 'Netzleistung (+Einspeisung / -Bezug)' },
	},
	{
		id: 'load.LP',
		field: 'LP',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Load power', de: 'Lastleistung' },
	},
	{
		id: 'pv.PV',
		field: 'PV',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Total PV power', de: 'PV-Gesamtleistung' },
	},
	{
		id: 'system.IW',
		field: 'IW',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Total input power', de: 'Gesamteingangsleistung' },
	},
	{
		id: 'system.OP',
		field: 'OP',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Total output power', de: 'Gesamtausgangsleistung' },
	},
	// PV strings (MPPT 1-4)
	{
		id: 'pv.mppt1.PV1',
		field: 'PV1',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'PV power MPPT 1', de: 'PV-Leistung MPPT 1' },
	},
	{
		id: 'pv.mppt2.PV2',
		field: 'PV2',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'PV power MPPT 2', de: 'PV-Leistung MPPT 2' },
	},
	{
		id: 'pv.mppt3.PV3',
		field: 'PV3',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'PV power MPPT 3', de: 'PV-Leistung MPPT 3' },
	},
	{
		id: 'pv.mppt4.PV4',
		field: 'PV4',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'PV power MPPT 4', de: 'PV-Leistung MPPT 4' },
	},
	{
		id: 'pv.mppt1.II1',
		field: 'II1',
		role: 'value.current',
		unit: 'A',
		type: 'number',
		name: { en: 'Current MPPT 1', de: 'Strom MPPT 1' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt2.II2',
		field: 'II2',
		role: 'value.current',
		unit: 'A',
		type: 'number',
		name: { en: 'Current MPPT 2', de: 'Strom MPPT 2' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt3.II3',
		field: 'II3',
		role: 'value.current',
		unit: 'A',
		type: 'number',
		name: { en: 'Current MPPT 3', de: 'Strom MPPT 3' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt4.II4',
		field: 'II4',
		role: 'value.current',
		unit: 'A',
		type: 'number',
		name: { en: 'Current MPPT 4', de: 'Strom MPPT 4' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt1.VP1',
		field: 'VP1',
		role: 'value.voltage',
		unit: 'V',
		type: 'number',
		name: { en: 'Voltage MPPT 1', de: 'Spannung MPPT 1' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt2.VP2',
		field: 'VP2',
		role: 'value.voltage',
		unit: 'V',
		type: 'number',
		name: { en: 'Voltage MPPT 2', de: 'Spannung MPPT 2' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt3.VP3',
		field: 'VP3',
		role: 'value.voltage',
		unit: 'V',
		type: 'number',
		name: { en: 'Voltage MPPT 3', de: 'Spannung MPPT 3' },
		scale: 0.1,
		decimals: 1,
	},
	{
		id: 'pv.mppt4.VP4',
		field: 'VP4',
		role: 'value.voltage',
		unit: 'V',
		type: 'number',
		name: { en: 'Voltage MPPT 4', de: 'Spannung MPPT 4' },
		scale: 0.1,
		decimals: 1,
	},
	// Daily energy counters (raw Wh, not kWh!). PD was removed as unsupported in v1.1.0.
	{
		// Per the official integration v1.1.0: GD1 = grid charge energy, GD2 = grid
		// feed-in energy (the earlier swap here was based on a faulty source summary).
		id: 'grid.GD1',
		field: 'GD1',
		role: 'value.energy',
		unit: 'Wh',
		type: 'number',
		name: { en: "Today's grid charge energy", de: 'Heutige Netzladeenergie' },
	},
	{
		id: 'grid.GD2',
		field: 'GD2',
		role: 'value.energy',
		unit: 'Wh',
		type: 'number',
		name: { en: "Today's grid feed-in energy", de: 'Heutige Netzeinspeiseenergie' },
	},
	{
		id: 'load.LD',
		field: 'LD',
		role: 'value.energy',
		unit: 'Wh',
		type: 'number',
		name: { en: 'Daily off-grid load energy', de: 'Tägliche Inselbetriebs-Lastenergie' },
	},
	// Battery topology / per-pack SoC
	{
		id: 'battery.SC0',
		field: 'SC0',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC master pack', de: 'Ladezustand Master-Pack' },
	},
	{
		id: 'battery.SC1',
		field: 'SC1',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC pack 1 (B500)', de: 'Ladezustand Pack 1 (B500)' },
	},
	{
		id: 'battery.SC2',
		field: 'SC2',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC pack 2', de: 'Ladezustand Pack 2' },
	},
	{
		id: 'battery.SC3',
		field: 'SC3',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC pack 3', de: 'Ladezustand Pack 3' },
	},
	{
		id: 'battery.SC4',
		field: 'SC4',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC pack 4', de: 'Ladezustand Pack 4' },
	},
	{
		id: 'battery.SC5',
		field: 'SC5',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'SoC pack 5', de: 'Ladezustand Pack 5' },
	},
	{
		id: 'battery.ON',
		field: 'ON',
		role: 'value',
		type: 'number',
		name: { en: 'Battery packs (online)', de: 'Batteriepacks (online)' },
	},
	{
		id: 'battery.SI1',
		field: 'SI1',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'Discharge SoC hysteresis', de: 'Entlade-SoC-Hysterese' },
	},
	{
		id: 'battery.SA1',
		field: 'SA1',
		role: 'value.battery',
		unit: '%',
		type: 'number',
		name: { en: 'Charge SoC hysteresis', de: 'Lade-SoC-Hysterese' },
	},
	// Device / status
	{
		id: 'device.ST',
		field: 'ST',
		role: 'value',
		type: 'number',
		name: { en: 'System status', de: 'Systemstatus' },
		states: { 0: 'Shutdown', 1: 'Standby', 2: 'Running', 3: 'Upgrading' },
	},
	{
		// PK is no longer reported on firmware >= 1.1.13 → derive it from DevType.
		id: 'device.PK',
		field: 'PK',
		role: 'value',
		type: 'number',
		name: { en: 'Device type (1=500 Standard, 2=500 Pro)', de: 'Gerätetyp (1=500 Standard, 2=500 Pro)' },
		derive: (d: ReportedState): number => {
			const n = Number(d.PK);
			if (Number.isFinite(n)) {
				return n;
			}
			const t = typeof d.DevType === 'string' ? d.DevType : '';
			return /pro/i.test(t) ? 2 : /500/.test(t) ? 1 : 0;
		},
	},
	{
		id: 'device.DevType',
		field: 'DevType',
		role: 'text',
		type: 'string',
		name: { en: 'Device model', de: 'Gerätemodell' },
	},
	{
		id: 'device.SN',
		field: 'SN',
		role: 'text',
		type: 'string',
		name: { en: 'Serial number', de: 'Seriennummer' },
	},
	{
		id: 'meter.MS',
		field: 'MS',
		role: 'value',
		type: 'number',
		name: { en: 'Meter status', de: 'Zählerstatus' },
		states: { 0: 'Unbound', 1: 'Online', 2: 'Offline', 3: 'Discovering' },
	},
	// Firmware
	{
		id: 'device.firmware.ES',
		field: 'ES',
		role: 'text',
		type: 'string',
		name: { en: 'Wi-Fi / module firmware (software)', de: 'WLAN-/Modul-Firmware (Software)' },
	},
	{
		id: 'device.firmware.AS',
		field: 'AS',
		role: 'text',
		type: 'string',
		name: { en: 'AC firmware (software)', de: 'AC-Firmware (Software)' },
	},
	{
		id: 'device.firmware.DS',
		field: 'DS',
		role: 'text',
		type: 'string',
		name: { en: 'DC firmware (software)', de: 'DC-Firmware (Software)' },
	},
	{
		id: 'device.firmware.BS0',
		field: 'BS0',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware master pack', de: 'BMS-Firmware Master-Pack' },
	},
	{
		id: 'device.firmware.BS1',
		field: 'BS1',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware pack 1 (B500)', de: 'BMS-Firmware Pack 1 (B500)' },
	},
	{
		id: 'device.firmware.BS2',
		field: 'BS2',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware pack 2', de: 'BMS-Firmware Pack 2' },
	},
	{
		id: 'device.firmware.BS3',
		field: 'BS3',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware pack 3', de: 'BMS-Firmware Pack 3' },
	},
	{
		id: 'device.firmware.BS4',
		field: 'BS4',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware pack 4', de: 'BMS-Firmware Pack 4' },
	},
	{
		id: 'device.firmware.BS5',
		field: 'BS5',
		role: 'text',
		type: 'string',
		name: { en: 'BMS firmware pack 5', de: 'BMS-Firmware Pack 5' },
	},
	// Device timestamp
	{
		id: 'info.timestamp',
		field: 'timestamp',
		role: 'value.time',
		unit: 'ms',
		type: 'number',
		name: { en: 'Device timestamp', de: 'Geräte-Zeitstempel' },
	},
	// --- Additional fields reported by firmware 1.1.13 (read-only) ---
	// Network / diagnostics
	{
		id: 'device.network.WR',
		field: 'WR',
		role: 'value',
		unit: 'dB',
		type: 'number',
		name: { en: 'Wi-Fi signal strength', de: 'WLAN-Signalstärke' },
	},
	{
		id: 'device.network.WS',
		field: 'WS',
		role: 'text',
		type: 'string',
		name: { en: 'Wi-Fi SSID', de: 'WLAN-SSID' },
	},
	{
		id: 'device.network.IP',
		field: 'IP',
		role: 'info.ip',
		type: 'string',
		name: { en: 'Local-mode IP address', de: 'IP-Adresse (lokaler Modus)' },
	},
	{
		id: 'device.network.COM',
		field: 'COM',
		role: 'value',
		type: 'number',
		name: { en: 'Local-mode port', de: 'Port (lokaler Modus)' },
	},
	{
		// Read-only: PT is a "reserved" field per the API docs, so we do not write it.
		id: 'device.PT',
		field: 'PT',
		role: 'value',
		unit: 'min',
		type: 'number',
		name: { en: 'Auto power-off time', de: 'Auto-Abschaltzeit' },
	},
	// Hardware firmware counterparts of ES/AS/DS
	{
		id: 'device.firmware.EH',
		field: 'EH',
		role: 'text',
		type: 'string',
		name: { en: 'Wi-Fi / module firmware (hardware)', de: 'WLAN-/Modul-Firmware (Hardware)' },
	},
	{
		id: 'device.firmware.AH',
		field: 'AH',
		role: 'text',
		type: 'string',
		name: { en: 'AC firmware (hardware)', de: 'AC-Firmware (Hardware)' },
	},
	{
		id: 'device.firmware.DH',
		field: 'DH',
		role: 'text',
		type: 'string',
		name: { en: 'DC firmware (hardware)', de: 'DC-Firmware (Hardware)' },
	},
	// UPS / bypass mode (read-only; writing these is out of release-1 scope)
	{
		id: 'ups.UO',
		field: 'UO',
		role: 'value',
		type: 'number',
		name: { en: 'UPS mode active (0/1)', de: 'USV-Modus aktiv (0/1)' },
	},
	// UP (UPS PV bypass power) was removed as unsupported in v1.1.0.
	{
		id: 'ups.UG',
		field: 'UG',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'UPS grid charge power', de: 'USV-Netzladeleistung' },
	},
	{
		id: 'ups.FP',
		field: 'FP',
		role: 'value.power',
		unit: 'W',
		type: 'number',
		name: { en: 'Max. PV bypass output after full charge', de: 'Max. PV-Bypass-Ausgang nach Vollladung' },
	},
	// Fault bitmasks (only present on the device when a fault is active). Treat as bitmasks.
	{
		id: 'fault.TF',
		field: 'TF',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (prompt)', de: 'Fehler-Bitmaske (Hinweis)' },
	},
	{
		id: 'fault.EF',
		field: 'EF',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (EMS)', de: 'Fehler-Bitmaske (EMS)' },
	},
	{
		id: 'fault.DF1',
		field: 'DF1',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (DC 1)', de: 'Fehler-Bitmaske (DC 1)' },
	},
	{
		id: 'fault.DF2',
		field: 'DF2',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (DC 2)', de: 'Fehler-Bitmaske (DC 2)' },
	},
	{
		id: 'fault.AF1',
		field: 'AF1',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (AC 1)', de: 'Fehler-Bitmaske (AC 1)' },
	},
	{
		id: 'fault.AF2',
		field: 'AF2',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (AC 2)', de: 'Fehler-Bitmaske (AC 2)' },
	},
	{
		id: 'fault.BF',
		field: 'BF',
		role: 'value',
		type: 'number',
		name: { en: 'Fault bitmask (BMS)', de: 'Fehler-Bitmaske (BMS)' },
	},
	// Any remaining/unknown reported field is not exposed individually; the complete
	// original /read response is kept in info.rawResponse (see main.ts).
];

/**
 * Writable control states. Each is also read back from /read (ack=true) so the
 * value reflects the device. A user write (ack=false) is sent to /write and then
 * confirmed by re-reading. The writable set matches the official HA integration,
 * minus fields the API docs flag as "reserved" (PT is therefore read-only):
 * GS, IS, SI, SA, SO, MM, MD, TZ, RT, MG, LM, LFB, LPS, PM.
 */
export const controlDefs: StateDef[] = [
	{
		id: 'control.GS',
		field: 'GS',
		role: 'level',
		unit: 'W',
		type: 'number',
		name: {
			en: 'Grid power setpoint (+feed-in / -grid charge)',
			de: 'Netzleistungs-Sollwert (+Einspeisung / -Netzladen)',
		},
		write: true,
	},
	{
		id: 'control.IS',
		field: 'IS',
		role: 'level',
		unit: 'W',
		type: 'number',
		name: { en: 'Max. grid feed-in / inverter output limit', de: 'Max. Netzeinspeisung / WR-Ausgangsgrenze' },
		write: true,
	},
	{
		id: 'control.SI',
		field: 'SI',
		role: 'level',
		unit: '%',
		type: 'number',
		name: { en: 'Min. discharge SoC (grid mode)', de: 'Min. Entlade-SoC (Netzbetrieb)' },
		write: true,
	},
	{
		id: 'control.SA',
		field: 'SA',
		role: 'level',
		unit: '%',
		type: 'number',
		name: { en: 'Max. charge SoC (grid mode)', de: 'Max. Lade-SoC (Netzbetrieb)' },
		write: true,
	},
	{
		id: 'control.SO',
		field: 'SO',
		role: 'level',
		unit: '%',
		type: 'number',
		name: { en: 'Min. discharge SoC (off-grid mode)', de: 'Min. Entlade-SoC (Inselbetrieb)' },
		write: true,
	},
	{
		id: 'control.MM',
		field: 'MM',
		role: 'switch',
		type: 'boolean',
		name: {
			en: 'Local zero feed-in / self-consumption mode',
			de: 'Lokale Nulleinspeisung / Eigenverbrauch',
		},
		write: true,
	},
	{
		id: 'control.MD',
		field: 'MD',
		role: 'json',
		type: 'string',
		name: { en: 'Meter connection JSON (MD)', de: 'Zählerverbindung JSON (MD)' },
		write: true,
	},
	{
		id: 'control.TZ',
		field: 'TZ',
		role: 'text',
		type: 'string',
		name: { en: 'POSIX timezone (TZ)', de: 'POSIX-Zeitzone (TZ)' },
		write: true,
	},
	{
		id: 'control.RT',
		field: 'RT',
		role: 'button',
		type: 'boolean',
		name: { en: 'Restart device', de: 'Gerät neu starten' },
		write: true,
	},
	// Writable fields matching the official HA integration's control surface
	{
		id: 'control.MG',
		field: 'MG',
		role: 'level',
		unit: 'W',
		type: 'number',
		name: { en: 'Max. grid-tied output power', de: 'Max. netzgekoppelte Ausgangsleistung' },
		write: true,
	},
	{
		// Warning: LM=1 blocks cloud/app remote control until reset.
		id: 'control.LM',
		field: 'LM',
		role: 'switch',
		type: 'boolean',
		name: { en: 'Local mode (blocks cloud control)', de: 'Lokaler Modus (blockiert Cloud)' },
		write: true,
	},
	{
		id: 'control.LFB',
		field: 'LFB',
		role: 'switch',
		type: 'boolean',
		name: { en: 'Load priority switch', de: 'Lastprioritäts-Schalter' },
		write: true,
	},
	{
		id: 'control.LPS',
		field: 'LPS',
		role: 'switch',
		type: 'boolean',
		name: { en: 'Off-grid output switch', de: 'Inselausgang-Schalter' },
		write: true,
	},
	{
		id: 'control.PM',
		field: 'PM',
		role: 'switch',
		type: 'boolean',
		name: { en: 'Parallel mode', de: 'Parallel-Modus' },
		write: true,
	},
];

/**
 * Applies the official MM/MD coupling to a /write payload (mutates and returns it):
 * turning self-consumption (MM) off also clears the meter config (MD), and writing
 * the meter config sets MM based on whether the config is empty.
 *
 * @param field - the API field the user wrote (MM or MD)
 * @param payload - the write payload to augment
 */
export function applyMeterModeCoupling(
	field: string,
	payload: Record<string, string | number>,
): Record<string, string | number> {
	if (field === 'MM' && payload.MM === 0) {
		payload.MD = '';
	} else if (field === 'MD') {
		payload.MM = payload.MD === '' ? 0 : 1;
	}
	return payload;
}

/** Meter types the storage can read on its own (Mode A / device self-regulation). */
export type MeterType = 'ecotracker' | 'shelly3em' | 'shellypro3em' | 'tasmota';

export interface MeterConfig {
	type: MeterType;
	/** Meter SN (mDNS types) or LAN IP (EcoTracker, direct mode). */
	id: string;
	/** Tasmota / BitShake energy-monitor subtype; resolves dat_str.pwr via the map below. */
	tasmotaSubtype?: string;
}

/**
 * Tasmota / BitShake energy-monitor subtypes and their `dat_str.pwr` key, from the
 * device's local API reference (section 5.4). Most subtypes report `Power`; a few
 * (LEPUS, PICUS, Smarty) report lowercase `power`. The admin UI offers these as a
 * dropdown so the user picks a meter rather than guessing the JSON key.
 */
export const TASMOTA_PWR_BY_SUBTYPE: Record<string, string> = {
	APOX: 'Power',
	LEPUS: 'power',
	Norax: 'Power',
	PICUS: 'power',
	GS303: 'Power',
	DWZE12: 'Power',
	DWS7410: 'Power',
	DWS7412: 'Power',
	DWS7420: 'Power',
	DWS7612: 'Power',
	DWSB12: 'Power',
	DWSB20: 'Power',
	DWSE20: 'Power',
	M60: 'Power',
	Q3A: 'Power',
	Q3B: 'Power',
	Q3C: 'Power',
	Q3D: 'Power',
	Q1A: 'Power',
	Q3M: 'Power',
	eBZ: 'Power',
	SGM: 'Power',
	AS2020: 'Power',
	AS3500: 'Power',
	eBZD: 'Power',
	ED300L: 'Power',
	ED300S: 'Power',
	EMH: 'Power',
	HBZ: 'Power',
	DTZ: 'Power',
	EHZ: 'Power',
	MT175: 'Power',
	MT176: 'Power',
	MT382: 'Power',
	MT631: 'Power',
	MT681: 'Power',
	MT691: 'Power',
	Itron: 'Power',
	KAIFA: 'Power',
	E220: 'Power',
	E320: 'Power',
	L20: 'Power',
	Smarty: 'power',
	SML: 'Power',
};

/**
 * Builds the device-side meter-connection JSON string (MD) for the four meter
 * types the storage supports natively, following the local API reference
 * section 5. Returns '' when required input is missing.
 *
 * For mDNS meters the host inside dat_url stays 0.0.0.0 — the device resolves the
 * real address from the SN itself. EcoTracker uses direct mode with the LAN IP.
 *
 * @param cfg - the configured meter
 */
export function buildMeterMd(cfg: MeterConfig): string {
	const id = (cfg.id || '').trim();
	if (!id) {
		return '';
	}
	switch (cfg.type) {
		case 'ecotracker':
			return JSON.stringify({
				mode: 'direct',
				direct: { dat_url: `http://${id}/v1/json` },
				dat_str: { pwr: 'power' },
			});
		case 'shelly3em':
			return JSON.stringify({
				mode: 'mdns',
				mdns: { sn: id, dat_url: 'http://0.0.0.0/status' },
				dat_str: { pwr: 'total_power' },
			});
		case 'shellypro3em':
			return JSON.stringify({
				mode: 'mdns',
				mdns: { sn: id, dat_url: 'http://0.0.0.0/rpc/EM.GetStatus?id=0' },
				dat_str: { pwr: 'total_act_power' },
			});
		case 'tasmota': {
			const pwr = TASMOTA_PWR_BY_SUBTYPE[(cfg.tasmotaSubtype || '').trim()];
			if (!pwr) {
				return ''; // unknown / unset subtype
			}
			return JSON.stringify({
				mode: 'mdns',
				mdns: { sn: id, dat_url: 'http://0.0.0.0/cm?cmnd=Status%208' },
				dat_str: { pwr },
			});
		}
		default:
			return '';
	}
}

/**
 * Scales and rounds a value to the given number of decimals; returns null for
 * non-finite/empty input.
 *
 * @param value
 * @param decimals
 * @param scale - factor applied before rounding (default 1)
 */
export function roundTo(value: unknown, decimals = 0, scale = 1): number | null {
	if (value == null || value === '') {
		return null;
	}
	const n = Number(value) * scale;
	if (!Number.isFinite(n)) {
		return null;
	}
	const factor = Math.pow(10, decimals);
	return Math.round(n * factor) / factor;
}

/**
 * Reads a numeric config value, falling back to a default only when the value is
 * missing or not a number. Unlike `Number(x) || def`, an explicit 0 is respected
 * (e.g. a dead band of 0 must stay 0 and not silently become the default).
 *
 * @param value raw config value
 * @param def default when the value is unset or invalid
 */
export function cfgNum(value: unknown, def: number): number {
	if (value === null || value === undefined || value === '') {
		return def;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : def;
}
