/**
 * Quotes a CSV field only when it needs it (contains a comma, quote, or
 * newline), doubling any internal quotes — the standard RFC 4180 minimal
 * escaping rule. `null`/`undefined` become an empty field, not the string
 * "null".
 */
export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

export function toCsvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(",") + "\r\n";
}
