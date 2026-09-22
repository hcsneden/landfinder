import { describe, expect, it } from 'vitest';
import { decodeRecords, toDataApiStatement } from './db';

describe('toDataApiStatement', () => {
  it('rewrites positional placeholders to named parameters', () => {
    const statement = toDataApiStatement('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 2]);
    expect(statement.sql).toBe('SELECT * FROM t WHERE a = :p1 AND b = :p2');
    expect(statement.parameters).toEqual([
      { name: 'p1', value: { stringValue: 'x' } },
      { name: 'p2', value: { longValue: 2 } },
    ]);
  });

  it('encodes nulls, booleans, doubles, dates, objects, and arrays', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const { parameters } = toDataApiStatement('', [null, true, 1.5, date, { a: 1 }, ['x', 'y"z', null]]);
    expect(parameters).toEqual([
      { name: 'p1', value: { isNull: true } },
      { name: 'p2', value: { booleanValue: true } },
      { name: 'p3', value: { doubleValue: 1.5 } },
      { name: 'p4', value: { stringValue: '2026-01-02 03:04:05.000' }, typeHint: 'TIMESTAMP' },
      { name: 'p5', value: { stringValue: '{"a":1}' } },
      { name: 'p6', value: { stringValue: '{"x","y\\"z",NULL}' } },
    ]);
  });
});

describe('decodeRecords', () => {
  it('decodes column types the way the query helpers expect', () => {
    const rows = decodeRecords<Record<string, unknown>>(
      [[
        { stringValue: '12.50' },
        { stringValue: '9007199254740993' },
        { stringValue: '{"k":1}' },
        { stringValue: '2026-01-02 03:04:05' },
        { isNull: true },
        { arrayValue: { stringValues: ['a', 'b'] } },
      ]],
      [
        { label: 'acreage', typeName: 'numeric' },
        { label: 'big', typeName: 'int8' },
        { label: 'data', typeName: 'jsonb' },
        { label: 'at', typeName: 'timestamptz' },
        { label: 'missing', typeName: 'text' },
        { label: 'tags', typeName: '_text' },
      ]
    );
    expect(rows[0]).toEqual({
      acreage: 12.5,
      big: '9007199254740993',
      data: { k: 1 },
      at: new Date('2026-01-02T03:04:05Z'),
      missing: null,
      tags: ['a', 'b'],
    });
  });
});
