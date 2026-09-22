import { describe, expect, it } from 'vitest';
import { splitStatements } from './sql';

describe('splitStatements', () => {
  it('splits on semicolons and keeps function bodies intact', () => {
    const sql = `
      -- leading comment
      CREATE TABLE a (id int);
      CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP INDEX IF EXISTS i
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('RETURN NEW;');
    expect(statements[2]).toBe('DROP INDEX IF EXISTS i');
  });

  it('drops statements that are only comments', () => {
    expect(splitStatements('-- only a comment\n')).toEqual([]);
  });
});
