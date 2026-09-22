import { describe, expect, it } from 'vitest';
import {
  addressVariants,
  hasNoHouseNumber,
  lotNumberAsHouseNumber,
  parseAddressParts,
  parseStreetNumber,
  roadName,
} from './address';

describe('addressVariants', () => {
  it('returns the original, expanded, and abbreviated forms', () => {
    expect(addressVariants('Pronghorn Ln')).toEqual(['Pronghorn Ln', 'Pronghorn lane']);
    expect(addressVariants('Elk Creek Road')).toEqual(['Elk Creek Road', 'Elk crk rd']);
  });
  it('leaves ordinals alone', () => {
    expect(addressVariants('1st Ave')).toEqual(['1st Ave', '1st avenue']);
  });
});

describe('parseStreetNumber', () => {
  it('strips the street type suffix', () => {
    expect(parseStreetNumber('123 Main St')).toEqual({ number: 123, name: 'Main' });
    expect(parseStreetNumber('45 Arcturus Drive')).toEqual({ number: 45, name: 'Arcturus' });
  });
  it('rejects addresses without a positive house number', () => {
    expect(parseStreetNumber('Main St')).toBeNull();
    expect(parseStreetNumber('0 Main St')).toBeNull();
  });
});

describe('parseAddressParts', () => {
  it('parses street, city, state, and zip', () => {
    expect(parseAddressParts('123 Main St, Bozeman, MT 59715')).toEqual({
      street: '123 Main St', city: 'Bozeman', state: 'MT', zip: '59715',
    });
  });
  it('returns null without three parts', () => {
    expect(parseAddressParts('no commas here')).toBeNull();
  });
});

describe('house number helpers', () => {
  it('detects TBD and zero prefixes', () => {
    expect(hasNoHouseNumber('TBD Arcturus Dr, Emigrant, MT')).toBe(true);
    expect(hasNoHouseNumber('0 Foo Rd')).toBe(true);
    expect(hasNoHouseNumber('123 Main St')).toBe(false);
  });
  it('rewrites a lot number as the house number', () => {
    expect(lotNumberAsHouseNumber('Nhn Foo Rd Lot 69, Emigrant, MT')).toBe('69 Foo Rd, Emigrant, MT');
    expect(lotNumberAsHouseNumber('12 Foo Rd Lot 69')).toBeNull();
  });
  it('extracts the road name from any form', () => {
    expect(roadName('Tbd Arcturus Dr, Emigrant, MT 59027')).toBe('Arcturus Dr');
    expect(roadName('Nhn Foo Rd Lot 69')).toBe('Foo Rd');
    expect(roadName('12 Foo Rd')).toBe('Foo Rd');
    expect(roadName('12 Fo')).toBeNull();
  });
});
