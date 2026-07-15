import type { ReactNode } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

/** Format milliseconds as compact human-readable duration units. */
export function formatDuration(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";

  let remaining = Math.max(0, Math.floor(value));
  if (remaining < SECOND_MS) return `${remaining}ms`;
  if (remaining < MINUTE_MS) {
    const seconds = remaining / SECOND_MS;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }

  const parts: string[] = [];
  const units: Array<[string, number]> = [
    ["mo", MONTH_MS],
    ["w", WEEK_MS],
    ["d", DAY_MS],
    ["h", HOUR_MS],
    ["m", MINUTE_MS],
    ["s", SECOND_MS],
  ];

  for (const [label, size] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    parts.push(`${count}${label}`);
    remaining %= size;
  }

  return parts.join(" ");
}

/** Render a compact human-readable duration. */
export function Duration(props: {
  fallback?: ReactNode;
  value: number | undefined;
}) {
  return <>{formatDuration(props.value) || props.fallback || null}</>;
}
