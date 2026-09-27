import { expect } from 'chai';
import { findDrift, parseDesired } from './restore';

const ALLOWED = new Set(['SI', 'SA', 'SO', 'IS']);

describe('parseDesired', () => {
	it('reads a stored record', () => {
		expect(parseDesired('{"SI":10,"SA":90}', ALLOWED)).to.deep.equal({ SI: 10, SA: 90 });
	});

	it('degrades a broken or empty record to nothing, never to a write', () => {
		for (const raw of ['', '   ', 'not json', '[1,2]', 'null', '42', undefined, null, 7]) {
			expect(parseDesired(raw, ALLOWED), String(raw)).to.deep.equal({});
		}
	});

	it('drops fields that may not be restored and values that are not numbers', () => {
		// The record sits in a state the operator can see and edit; an entry for GS or a
		// string value must not turn into a write.
		expect(parseDesired('{"SI":10,"GS":-2400,"SA":"95","SO":null,"IS":1e999}', ALLOWED)).to.deep.equal({
			SI: 10,
		});
	});
});

describe('findDrift', () => {
	it('reports nothing while the head reports what was set', () => {
		expect(findDrift({ SI: 10, SA: 95 }, { SI: 10, SA: 95, GS: 0 })).to.deep.equal({});
	});

	it('reports the fields the head lost', () => {
		// The restart case: the head comes back with an older stored value.
		expect(findDrift({ SI: 10, SA: 95 }, { SI: 5, SA: 95 })).to.deep.equal({ SI: 10 });
	});

	it('compares numerically, as the head may deliver numbers as text', () => {
		expect(findDrift({ SI: 10 }, { SI: '10' })).to.deep.equal({});
	});

	it('restores a field the head reports without a usable value', () => {
		expect(findDrift({ SI: 10 }, { SI: null })).to.deep.equal({ SI: 10 });
	});

	it('leaves out a field the firmware does not report at all', () => {
		// Older firmware lacks some fields; writing one it does not know achieves nothing.
		expect(findDrift({ SI: 10, SI1: 5 }, { SI: 10 })).to.deep.equal({});
	});
});
