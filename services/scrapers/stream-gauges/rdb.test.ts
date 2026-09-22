import { describe, expect, it } from 'vitest';
import { extractStreamName, parseRdb } from './rdb';

describe('parseRdb', () => {
  it('skips comments and the type code row', () => {
    const text = [
      '# USGS comment',
      'site_no\tstation_nm\tdec_lat_va',
      '15s\t50s\t16n',
      '06052500\tGALLATIN RIVER AT LOGAN MT\t45.88',
      '',
    ].join('\n');
    expect(parseRdb(text)).toEqual([
      { site_no: '06052500', station_nm: 'GALLATIN RIVER AT LOGAN MT', dec_lat_va: '45.88' },
    ]);
  });

  it('returns nothing for a header-only file', () => {
    expect(parseRdb('site_no\tstation_nm\n15s\t50s\n')).toEqual([]);
  });
});

describe('extractStreamName', () => {
  it('takes the stream name before the location word', () => {
    expect(extractStreamName('BITTERROOT RIVER NEAR DARBY MT')).toBe('Bitterroot River');
    expect(extractStreamName('CLARK FORK AT MISSOULA MT')).toBe('Clark Fork');
    expect(extractStreamName('NO LOCATION WORD')).toBeNull();
  });
});
