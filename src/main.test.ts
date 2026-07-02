/**
 * Unit tests for pure helper logic of the SunEnergyXT 500 adapter.
 */

import { expect } from 'chai';
import { applyMeterModeCoupling, buildMeterMd, cfgNum, controlDefs, measurementDefs, roundTo } from './lib/states';

describe('cfgNum', () => {
	it('respects an explicit zero instead of falling back to the default', () => {
		expect(cfgNum(0, 10)).to.equal(0);
		expect(cfgNum('0', 10)).to.equal(0);
	});

	it('falls back for missing or invalid values', () => {
		expect(cfgNum(undefined, 10)).to.equal(10);
		expect(cfgNum(null, 10)).to.equal(10);
		expect(cfgNum('', 10)).to.equal(10);
		expect(cfgNum('abc', 10)).to.equal(10);
		expect(cfgNum(NaN, 10)).to.equal(10);
	});

	it('parses numeric strings and keeps real numbers', () => {
		expect(cfgNum('5', 10)).to.equal(5);
		expect(cfgNum(0.3, 1)).to.equal(0.3);
	});
});

describe('roundTo', () => {
	it('rounds to integer by default', () => {
		expect(roundTo(1530.4)).to.equal(1530);
		expect(roundTo(1530.6)).to.equal(1531);
	});

	it('rounds to the requested number of decimals', () => {
		expect(roundTo(219.04, 1)).to.equal(219);
		expect(roundTo(2.149, 1)).to.equal(2.1);
	});

	it('accepts numeric strings', () => {
		expect(roundTo('42', 0)).to.equal(42);
	});

	it('returns null for non-finite input', () => {
		expect(roundTo('abc')).to.equal(null);
		expect(roundTo(undefined)).to.equal(null);
		expect(roundTo(null)).to.equal(null);
		expect(roundTo(NaN)).to.equal(null);
	});
});

describe('state definitions', () => {
	it('have unique object ids', () => {
		const ids = [...measurementDefs, ...controlDefs].map(d => d.id);
		expect(new Set(ids).size).to.equal(ids.length);
	});

	it('expose the official writable fields except reserved ones (no PT)', () => {
		const writable = controlDefs
			.filter(d => d.write)
			.map(d => d.field)
			.sort();
		expect(writable).to.deep.equal(
			['GS', 'IS', 'SI', 'SA', 'SO', 'MM', 'MD', 'TZ', 'RT', 'MG', 'LM', 'LFB', 'LPS', 'PM'].sort(),
		);
	});

	it('does not expose any API-reserved field as writable', () => {
		const reserved = ['SI1', 'SA1', 'PO', 'PT', 'SD', 'CF'];
		const writableFields = controlDefs.filter(d => d.write).map(d => d.field);
		for (const r of reserved) {
			expect(writableFields, `reserved field ${r} must not be writable`).to.not.include(r);
		}
	});
});

describe('applyMeterModeCoupling', () => {
	it('clears MD when self-consumption (MM) is turned off', () => {
		expect(applyMeterModeCoupling('MM', { MM: 0 })).to.deep.equal({ MM: 0, MD: '' });
	});

	it('leaves MD untouched when MM is turned on', () => {
		expect(applyMeterModeCoupling('MM', { MM: 1 })).to.deep.equal({ MM: 1 });
	});

	it('enables MM when a non-empty meter config is written', () => {
		expect(applyMeterModeCoupling('MD', { MD: '{"mode":"mdns"}' })).to.deep.equal({
			MD: '{"mode":"mdns"}',
			MM: 1,
		});
	});

	it('disables MM when an empty meter config is written', () => {
		expect(applyMeterModeCoupling('MD', { MD: '' })).to.deep.equal({ MD: '', MM: 0 });
	});

	it('does not touch unrelated fields', () => {
		expect(applyMeterModeCoupling('GS', { GS: 1500 })).to.deep.equal({ GS: 1500 });
	});
});

describe('buildMeterMd', () => {
	it('builds a Shelly Pro 3EM mDNS binding from the SN', () => {
		expect(JSON.parse(buildMeterMd({ type: 'shellypro3em', id: '2cbcbba69cfc' }))).to.deep.equal({
			mode: 'mdns',
			mdns: { sn: '2cbcbba69cfc', dat_url: 'http://0.0.0.0/rpc/EM.GetStatus?id=0' },
			dat_str: { pwr: 'total_act_power' },
		});
	});

	it('builds a Shelly 3EM mDNS binding', () => {
		expect(JSON.parse(buildMeterMd({ type: 'shelly3em', id: 'abc123' }))).to.deep.equal({
			mode: 'mdns',
			mdns: { sn: 'abc123', dat_url: 'http://0.0.0.0/status' },
			dat_str: { pwr: 'total_power' },
		});
	});

	it('builds an EcoTracker direct binding from the LAN IP', () => {
		expect(JSON.parse(buildMeterMd({ type: 'ecotracker', id: '192.168.1.50' }))).to.deep.equal({
			mode: 'direct',
			direct: { dat_url: 'http://192.168.1.50/v1/json' },
			dat_str: { pwr: 'power' },
		});
	});

	it('derives the Tasmota power key from the subtype (uppercase Power)', () => {
		expect(
			JSON.parse(buildMeterMd({ type: 'tasmota', id: 'tasmota-c28338', tasmotaSubtype: 'MT681' })),
		).to.deep.equal({
			mode: 'mdns',
			mdns: { sn: 'tasmota-c28338', dat_url: 'http://0.0.0.0/cm?cmnd=Status%208' },
			dat_str: { pwr: 'Power' },
		});
	});

	it('derives the lowercase power key for subtypes that use it', () => {
		expect(
			JSON.parse(buildMeterMd({ type: 'tasmota', id: 'tas', tasmotaSubtype: 'Smarty' })).dat_str,
		).to.deep.equal({
			pwr: 'power',
		});
	});

	it('returns empty string when the id is missing', () => {
		expect(buildMeterMd({ type: 'shellypro3em', id: '' })).to.equal('');
		expect(buildMeterMd({ type: 'shellypro3em', id: '   ' })).to.equal('');
	});

	it('returns empty string for Tasmota with an unknown / unset subtype', () => {
		expect(buildMeterMd({ type: 'tasmota', id: 'tas-prefix' })).to.equal('');
		expect(buildMeterMd({ type: 'tasmota', id: 'tas-prefix', tasmotaSubtype: 'NOPE' })).to.equal('');
	});
});
