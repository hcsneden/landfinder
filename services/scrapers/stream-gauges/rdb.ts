/**
 * Parses the USGS RDB format: tab-delimited, `#` comment lines, a header row,
 * then a row of column type codes that is skipped.
 */
export function parseRdb(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  const [headerLine, , ...rows] = lines;
  if (!headerLine || rows.length === 0) return [];
  const headers = headerLine.split('\t').map((header) => header.trim());
  return rows.map((line) => {
    const values = line.split('\t');
    return Object.fromEntries(headers.map((header, i) => [header, (values[i] ?? '').trim()]));
  });
}

/** Turns "BITTERROOT RIVER NEAR DARBY MT" into "Bitterroot River". */
export function extractStreamName(stationName: string): string | null {
  const match = stationName.match(/^(.+?)\s+(?:NEAR|AT|ABOVE|BELOW|NR|BL|AB)\s+/i);
  if (!match) return null;
  return match[1]!.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
