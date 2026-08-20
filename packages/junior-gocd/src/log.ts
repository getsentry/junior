/** Console-log processing helpers for the GoCD job_log tool. */

const SECRET_KEY_PATTERN =
  /\b(authorization|proxy-authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|x-goog-signature|x-amz-signature|signature)("?\s*[:=]\s*"?)(?:[A-Za-z][A-Za-z0-9-]*\s+)?[^\s&"']+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;

// Mask a sensitive key's value, any auth scheme word (Basic/Token/bearer), and
// quoted JSON values; the trailing-space requirement keeps bare `token=abc` safe.
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_KEY_PATTERN, (_m, key, sep) => `${key}${sep}[REDACTED]`)
    .replace(BEARER_PATTERN, "bearer [REDACTED]");
}

function normalize(line: string): string {
  return line.replace(/\d+/g, "#");
}

/**
 * Collapse each run of `minRun`+ consecutive near-identical lines (equal after
 * masking digits) into the first line plus a count marker.
 */
export function dedupeConsecutive(
  lines: string[],
  minRun = 3,
): { lines: string[]; deduped: boolean } {
  const out: string[] = [];
  let deduped = false;
  let i = 0;
  while (i < lines.length) {
    const form = normalize(lines[i]!);
    let j = i;
    while (j + 1 < lines.length && normalize(lines[j + 1]!) === form) j++;
    const runLength = j - i + 1;
    if (runLength >= minRun) {
      out.push(lines[i]!, `… ${runLength - 1} more similar lines`);
      deduped = true;
    } else {
      for (let k = i; k <= j; k++) out.push(lines[k]!);
    }
    i = j + 1;
  }
  return { lines: out, deduped };
}

/** Keep only the last `n` lines, reporting whether earlier lines were dropped. */
export function tailLines(
  lines: string[],
  n: number,
): { lines: string[]; truncated: boolean } {
  if (lines.length <= n) return { lines, truncated: false };
  return { lines: lines.slice(lines.length - n), truncated: true };
}
