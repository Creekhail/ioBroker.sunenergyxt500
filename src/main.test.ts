/**
 * Unit tests for pure helper logic of the SunEnergyXT 500 adapter.
 */

import { expect } from 'chai';
import { asString, errMsg, hostKey, num } from './lib/values';
import { controllerStateDefs } from './lib/controller';
import { NAME_TRANSLATIONS } from './lib/name-translations';
import {
	applyMeterModeCoupling,
	buildMeterMd,
	cfgNum,
	controlDefs,
	measurementDefs,
	roundTo,
	subscribedControlPatterns,
} from './lib/states';

describe('state name translations', () => {
	const LANGS = ['ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

	it('cover every state definition name in all recommended languages', () => {
		// Guard: regenerate name-translations.ts after adding or renaming states
		// (scratchpad script gen-name-translations.js).
		for (const def of [...measurementDefs, ...controlDefs, ...controllerStateDefs]) {
			const entry = NAME_TRANSLATIONS[def.name.en];
			expect(entry, `missing translations for "${def.name.en}"`).to.be.an('object');
			for (const lang of LANGS) {
				expect(entry[lang], `missing ${lang} for "${def.name.en}"`).to.be.a('string').and.not.equal('');
			}
		}
	});
});

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

	it('expose exactly the documented writable fields', () => {
		// Across ALL definitions, not just controlDefs: SI1/SA1 are writable while
		// keeping their historic battery.* ids, so a controlDefs-only check would
		// silently miss them and this list would stop meaning anything.
		const writable = [...measurementDefs, ...controlDefs]
			.filter(d => d.write)
			.map(d => d.field)
			.sort();
		expect(writable).to.deep.equal(
			['GS', 'IS', 'SI', 'SA', 'SI1', 'SA1', 'SO', 'MM', 'MD', 'TZ', 'RT', 'MG', 'LM', 'LFB', 'LPS', 'PM'].sort(),
		);
	});

	it('does not expose any API-reserved field as writable', () => {
		// SI1/SA1 were on this list until the manufacturer documented them as writable
		// with a 5% default; PO/PT/SD/CF remain reserved.
		const reserved = ['PO', 'PT', 'SD', 'CF'];
		const writableFields = [...measurementDefs, ...controlDefs].filter(d => d.write).map(d => d.field);
		for (const r of reserved) {
			expect(writableFields, `reserved field ${r} must not be writable`).to.not.include(r);
		}
	});

	it('subscribes to every writable state and nothing else', () => {
		const all = [...measurementDefs, ...controlDefs];
		const patterns = subscribedControlPatterns(all);
		const writableIds = all.filter(d => d.write).map(d => `heads.*.${d.id}`);
		expect(patterns.slice().sort()).to.deep.equal(writableIds.slice().sort());
		// The historic battery.* ids must be covered despite sitting outside control.*.
		expect(patterns).to.include('heads.*.battery.SI1');
		expect(patterns).to.include('heads.*.battery.SA1');
		// Read-only measurements must not generate subscriptions.
		expect(patterns).to.not.include('heads.*.battery.SC');
		expect(patterns).to.not.include('heads.*.grid.GP');
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

describe('num', () => {
	it('accepts real numbers and numeric strings', () => {
		expect(num(0)).to.equal(0);
		expect(num(-1500)).to.equal(-1500);
		expect(num('42')).to.equal(42);
	});

	it('rejects values that Number() would silently turn into 0', () => {
		// This is the point of the helper: Number(null), Number('') and Number(false)
		// are all 0 and pass isFinite, so a missing field would become a real reading
		// of zero watts — or, for SI, a discharge floor of 0 %.
		expect(num(null)).to.equal(undefined);
		expect(num(undefined)).to.equal(undefined);
		expect(num('')).to.equal(undefined);
		expect(num(false)).to.equal(undefined);
		expect(num(true)).to.equal(undefined);
	});

	it('rejects non-numeric junk', () => {
		expect(num('abc')).to.equal(undefined);
		expect(num({})).to.equal(undefined);
		expect(num(NaN)).to.equal(undefined);
		expect(num(Infinity)).to.equal(undefined);
	});
});

describe('asString', () => {
	it('renders primitives and serialises objects', () => {
		expect(asString('x')).to.equal('x');
		expect(asString(5)).to.equal('5');
		expect(asString(null)).to.equal('');
		expect(asString(undefined)).to.equal('');
		expect(asString({ a: 1 })).to.equal('{"a":1}');
	});
});

describe('errMsg', () => {
	it('prefers the Error message over its string form', () => {
		expect(errMsg(new Error('boom'))).to.equal('boom');
		expect(errMsg('plain')).to.equal('plain');
		expect(errMsg(undefined)).to.equal('undefined');
	});
});

describe('hostKey', () => {
	it('treats the spellings of one address as one device', () => {
		const same = ['192.168.1.5', '192.168.1.5/', 'http://192.168.1.5', 'HTTPS://192.168.1.5//', ' 192.168.1.5 '];
		const keys = new Set(same.map(hostKey));
		expect([...keys]).to.deep.equal(['192.168.1.5']);
	});

	it('keeps genuinely different addresses apart', () => {
		expect(hostKey('192.168.1.5')).to.not.equal(hostKey('192.168.1.6'));
		// The port is part of the address, not decoration.
		expect(hostKey('192.168.1.5:8080')).to.not.equal(hostKey('192.168.1.5'));
	});

	it('survives an empty or missing value', () => {
		expect(hostKey('')).to.equal('');
		expect(hostKey(undefined as unknown as string)).to.equal('');
	});
});
