import { describe, expect, it } from 'vitest';
import { classifyFloodZone } from './environmentalRisk';

describe('classifyFloodZone', () => {
  it.each([
    ['X', 'minimal'],
    ['C', 'minimal'],
    ['B', 'moderate'],
    ['X500', 'moderate'],
    ['D', 'undetermined'],
    ['AE', 'high'],
    ['A', 'high'],
    ['VE', 'high'],
    ['ae ', 'high'],
    ['ZZ', 'undetermined'],
  ])('classifies zone %s as %s', (zone, expected) => {
    expect(classifyFloodZone(zone)).toBe(expected);
  });
});
