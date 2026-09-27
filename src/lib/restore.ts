/*
 * Keeping user settings across a head restart.
 *
 * Firmware 1.1.15 (marketed 1.1.5) does not keep values written through the local API:
 * after a restart the head comes back with an older stored set. With local mode on,
 * the vendor app cannot change settings either, so a value the operator set through
 * this adapter would silently fall back and stay there. The adapter therefore keeps
 * its own record of what was set and puts it back when the head reports otherwise.
 *
 * Only numeric fields take part (switches travel as 0/1). TZ and MD are left out: the
 * vendor documents that the head may not echo them exactly as written, so a comparison
 * would never settle and would rewrite them forever.
 */

import type { ReportedState } from './api';
import { num } from './values';

/** What the operator set through the adapter, per API field. */
export type DesiredSettings = Record<string, number>;

/**
 * Reads a stored record, dropping anything that is not a finite number.
 *
 * The record lives in a state the operator can see, so it may have been edited or
 * truncated; a broken record must degrade to "nothing to restore", never to a write.
 *
 * @param raw the stored JSON string
 * @param allowed API fields that may be restored
 */
export function parseDesired(raw: unknown, allowed: ReadonlySet<string>): DesiredSettings {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const out: DesiredSettings = {};
	for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (allowed.has(field) && typeof value === 'number' && Number.isFinite(value)) {
			out[field] = value;
		}
	}
	return out;
}

/**
 * The fields whose reported value differs from the operator's setting.
 *
 * A field the head does not report is skipped rather than written: older firmware
 * simply lacks some fields, and writing one it does not know achieves nothing.
 *
 * @param desired what the operator set
 * @param reported the head's latest snapshot
 * @returns the values to write back, keyed by API field
 */
export function findDrift(desired: DesiredSettings, reported: ReportedState): DesiredSettings {
	const drift: DesiredSettings = {};
	for (const [field, want] of Object.entries(desired)) {
		if (!(field in reported)) {
			continue;
		}
		const have = num(reported[field]);
		if (have === undefined || have !== want) {
			drift[field] = want;
		}
	}
	return drift;
}
