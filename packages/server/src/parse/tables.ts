/**
 * Markdown table parsing, deliberately matching tools/design/feedback-check.mjs.
 *
 * The validator splits cells by stripping the leading/trailing pipe and splitting
 * on `|`, and skips divider rows. Studio uses the same rules so that what it shows
 * a designer and what the validator sees are never two different tables.
 */

/** Split a row into trimmed cells, dropping the leading/trailing pipes. */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function isDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/**
 * Read every row of the first table whose header matches `columns` (case-insensitive,
 * positionally — the validator's own test). Returns [] when no such table exists.
 */
export function readTable(body: string, columns: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let headerSeen = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    if (isDivider(line)) continue;
    const c = cells(line);
    if (!headerSeen) {
      const lower = c.map((x) => x.toLowerCase());
      if (columns.every((col, i) => lower[i] === col.toLowerCase())) headerSeen = true;
      continue;
    }
    if (c.length < columns.length) continue;
    rows.push(Object.fromEntries(columns.map((col, i) => [col, c[i]])));
  }
  return rows;
}

/** The section of a markdown document under `## <heading>`, up to the next heading of the same or higher level. */
export function section(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const target = heading.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase().startsWith(target)) {
        start = i + 1;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) return lines.slice(start, i).join("\n");
  }
  return start === -1 ? null : lines.slice(start).join("\n");
}
