// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			// Connection
			host: string;
			pollInterval: number;
			requestTimeout: number;
			// Control mode selector: off = monitoring only, controller = adapter
			// drives GS (Mode B), device = storage self-regulates from a bound meter (Mode A)
			controlMode: 'off' | 'controller' | 'device';
			// Mode B — self-consumption controller
			gridPowerStateId: string;
			gridPowerInverted: boolean;
			controllerGain: number;
			controllerDeadBandW: number;
			controllerMinIntervalMs: number;
			controllerMaxPowerW: number;
			watchdogWarnSec: number;
			watchdogFailsafeSec: number;
			// Mode A — device-native meter binding
			meterType: 'ecotracker' | 'shelly3em' | 'shellypro3em' | 'tasmota';
			meterId: string;
			meterTasmotaSubtype: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
