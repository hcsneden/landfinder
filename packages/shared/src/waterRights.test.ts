import { describe, expect, it } from 'vitest';
import { parsePriorityDate, parseWaterRightStatus, parseWaterType } from './waterRights';

describe('parseWaterRightStatus', () => {
  it.each([
    ['ACTIVE', 'active'],
    ['Active', 'active'],
    ['INACTIVE', 'inactive'],
    ['TERMINATED', 'inactive'],
    ['ABANDONED', 'inactive'],
    ['PENDING', 'pending'],
    ['APPLICATION', 'pending'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['SOMETHING ELSE', 'unknown'],
  ])('maps %j to %s', (input, expected) => {
    expect(parseWaterRightStatus(input)).toBe(expected);
  });
});

describe('parseWaterType', () => {
  it('detects mixed, groundwater, and surface sources', () => {
    expect(parseWaterType('SURFACE WATER, GROUNDWATER')).toBe('mixed');
    expect(parseWaterType('GROUNDWATER')).toBe('groundwater');
    expect(parseWaterType('SURFACE WATER')).toBe('surface');
    expect(parseWaterType(null)).toBe('surface');
  });
});

describe('parsePriorityDate', () => {
  it('prefers the epoch millisecond field', () => {
    expect(parsePriorityDate(86_400_000, '1889-11-08')).toBe('1970-01-02');
  });
  it('falls back to a parseable text date', () => {
    expect(parsePriorityDate(null, '1889-11-08T00:00:00Z')).toBe('1889-11-08');
  });
  it('returns null when neither field is usable', () => {
    expect(parsePriorityDate(null, 'not a date')).toBeNull();
    expect(parsePriorityDate(undefined, undefined)).toBeNull();
  });
});
