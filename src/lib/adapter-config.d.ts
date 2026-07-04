// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			// Connection — up to 3 storage heads managed by this single instance.
			// Head 1 is required; heads 2 and 3 are optional (empty host = unused).
			head1Host: string;
			head1Label: string;
			head2Host: string;
			head2Label: string;
			head3Host: string;
			head3Label: string;
			pollInterval: number;
			requestTimeout: number;
			// Control mode selector: off = monitoring only, controller = adapter drives
			// GS across all heads (Mode B), device = a single storage self-regulates from a
			// bound meter (Mode A, only available with exactly one head).
			controlMode: 'off' | 'controller' | 'device';
			// Mode B — self-consumption controller (one loop, split across heads)
			gridPowerStateId: string;
			gridPowerInverted: boolean;
			// Target grid power in W (>0 = deliberate draw, <0 = deliberate feed-in; 0 = zero feed-in).
			controllerTargetW: number;
			controllerGain: number;
			controllerDeadBandW: number;
			// Maximum movement of the total setpoint per correction step (0 = unlimited).
			controllerMaxStepW: number;
			controllerMinIntervalMs: number;
			// Minimum change of a head's setpoint before it is re-written (anti-chatter).
			controllerWriteDeadBandW: number;
			watchdogWarnSec: number;
			watchdogFailsafeSec: number;
			// Mode A — device-native meter binding (single head only)
			meterType: 'ecotracker' | 'shelly3em' | 'shellypro3em' | 'tasmota';
			meterId: string;
			meterTasmotaSubtype: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
