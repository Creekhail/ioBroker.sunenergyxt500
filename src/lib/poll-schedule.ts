/*
 * Timing of the per-head poll cycles.
 *
 * The heads share one Wi-Fi channel and carry a weak on-board antenna, so the two
 * things the adapter can cheaply do for them are: never transmit to all heads in the
 * same instant, and stop hammering a head that has already dropped out.
 */

/**
 * Largest offset by which two heads' polls are staggered (ms). Beyond a second the
 * heads' snapshots would drift apart noticeably without any further radio benefit.
 */
export const POLL_STAGGER_MAX_MS = 1000;

/** Upper bound for the back-off delay after consecutive poll failures (ms). */
export const POLL_BACKOFF_MAX_MS = 60000;

/** Number of consecutive failures after which the back-off stops growing. */
export const POLL_BACKOFF_MAX_STEPS = 4;

/**
 * Start offset of one head's poll cycle, so the heads are spread across the interval
 * instead of transmitting simultaneously.
 *
 * @param index 1-based head number
 * @param count number of configured heads
 * @param intervalMs the configured poll interval in ms
 */
export function pollStaggerMs(index: number, count: number, intervalMs: number): number {
	const step = Math.min(POLL_STAGGER_MAX_MS, Math.floor(intervalMs / Math.max(1, count)));
	return Math.max(0, index - 1) * step;
}

/**
 * Delay until a head's next poll: the configured interval while it answers, doubling
 * per consecutive failure afterwards. Polling an unreachable head at full rate only
 * adds to the congestion that made it drop out in the first place.
 *
 * @param intervalMs the configured poll interval in ms
 * @param failures number of consecutive failed polls (0 = the last one succeeded)
 */
export function pollBackoffMs(intervalMs: number, failures: number): number {
	if (failures <= 0) {
		return intervalMs;
	}
	const factor = 2 ** Math.min(failures - 1, POLL_BACKOFF_MAX_STEPS);
	// A configured interval longer than the cap always wins — the back-off may only
	// ever slow polling down, never speed it up beyond what the user asked for.
	return Math.min(intervalMs * factor, Math.max(intervalMs, POLL_BACKOFF_MAX_MS));
}
