/** Splits a script into statements on semicolons that are outside $$ function bodies. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inDollarQuote = !inDollarQuote;
      current += '$$';
      i++;
      continue;
    }
    if (sql[i] === ';' && !inDollarQuote) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += sql[i];
  }
  if (current.trim()) statements.push(current.trim());
  return statements.filter((statement) => !/^(--[^\n]*\n?)+$/.test(statement));
}
