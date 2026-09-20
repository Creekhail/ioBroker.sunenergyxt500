/*
 * Pure value helpers shared by the adapter.
 *
 * They deliberately live outside main.ts: importing that file pulls in
 * @iobroker/adapter-core, which expects a running js-controller, so nothing defined
 * there can be unit-tested. Parsing device values is exactly the kind of code that
 * benefits most from tests, so it stays free of adapter dependencies.
 */

import type { ReportedState } from './api';

/**
 * Extracts a readable message from an unknown thrown value.
 *
 * @param e the caught value
 */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Model-based power limit used when the device does not report MG:
 * 500 (PK=1) → 800 W, 500 PRO (PK=2) → 2400 W; unknown models assume a PRO.
 *
 * @param data the head's reported state
 */
export function fallbackMaxPower(data: ReportedState): number {
	const pk = num(data.PK);
	if (pk === 1) {
		return 800;
	}
	if (pk === 2) {
		return 2400;
	}
	const devType = typeof data.DevType === 'string' ? data.DevType : '';
	if (devType && !/pro/i.test(devType)) {
		return 800;
	}
	return 2400;
}

/**
 * Parses an unknown API value to a finite number, or undefined.
 *
 * @param value raw value as delivered by the device
 */
export function num(value: unknown): number | undefined {
	// Number(null), Number('') and Number(false) are all 0 and pass isFinite, so an
	// absent field would silently become a real reading of zero watts or zero percent.
	// For SI that matters: a null there must fall through to the SO fallback, not be
	// taken as "discharge down to 0 %".
	if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
		return undefined;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Safely converts an unknown API value to a string (objects become JSON).
 *
 * @param value raw value as delivered by the device
 */
export function asString(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return JSON.stringify(value);
}

/**
 * Comparison key for a head address.
 *
 * "192.168.1.5", "192.168.1.5/" and "http://192.168.1.5" name the same device, so
 * comparing the raw strings would treat a head as removed after a purely cosmetic
 * edit — and then write to it as if it were a stranger. The raw form is what gets
 * stored and handed to the HTTP client; only comparisons go through this.
 *
 * @param host the address as configured or as recorded earlier
 */
export function hostKey(host: string): string {
	return (host || '')
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}
