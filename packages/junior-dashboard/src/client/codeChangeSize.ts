import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { formatCompactNumber } from "./format";

const exact = new Intl.NumberFormat("en-US");

function plural(count: number, noun: string): string {
  return `${exact.format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Describe a code change's size: `short` is the short form, such as
 * `+1.2k −340 · 12 files`, and `label` names the exact counts, such as
 * "1,204 lines added, 340 removed, 12 files changed". An unknown part is
 * left out, never shown as 0. Undefined when no part is known.
 */
export function codeChangeSize(
  size: CodeChangeSize | undefined,
): { label: string; short: string } | undefined {
  const { additions, changedFiles, deletions } = size ?? {};
  const lines = [
    additions === undefined ? undefined : `+${formatCompactNumber(additions)}`,
    deletions === undefined ? undefined : `−${formatCompactNumber(deletions)}`,
  ].filter(Boolean);
  const short = [
    lines.join(" "),
    changedFiles === undefined
      ? undefined
      : `${formatCompactNumber(changedFiles)} file${changedFiles === 1 ? "" : "s"}`,
  ].filter(Boolean);
  if (short.length === 0) return undefined;
  const label = [
    additions === undefined ? undefined : `${plural(additions, "line")} added`,
    deletions === undefined
      ? undefined
      : additions === undefined
        ? `${plural(deletions, "line")} removed`
        : `${exact.format(deletions)} removed`,
    changedFiles === undefined
      ? undefined
      : `${plural(changedFiles, "file")} changed`,
  ].filter(Boolean);
  return { label: label.join(", "), short: short.join(" · ") };
}
