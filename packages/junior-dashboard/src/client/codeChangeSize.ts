import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import { formatCompactNumber } from "./format";

const exact = new Intl.NumberFormat("en-US");

function plural(count: number, noun: string): string {
  return `${exact.format(count)} ${noun}${count === 1 ? "" : "s"}`;
}

type ChangeSizeParts = {
  added?: string;
  files?: string;
  label: string;
  removed?: string;
};

/**
 * Describe a code change's size: the short parts, such as `+1.2k`, `−340`
 * and `12 files`, and a `label` that names the exact counts, such as
 * "1,204 lines added, 340 removed, 12 files changed". An unknown part is
 * left out, never shown as 0. Undefined when no part is known.
 */
export function codeChangeSize(
  size: CodeChangeSize | undefined,
): ChangeSizeParts | undefined {
  const { additions, changedFiles, deletions } = size ?? {};
  if (
    additions === undefined &&
    deletions === undefined &&
    changedFiles === undefined
  ) {
    return undefined;
  }
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
  const parts: ChangeSizeParts = { label: label.join(", ") };
  if (additions !== undefined) {
    parts.added = `+${formatCompactNumber(additions)}`;
  }
  if (deletions !== undefined) {
    parts.removed = `−${formatCompactNumber(deletions)}`;
  }
  if (changedFiles !== undefined) {
    parts.files = `${formatCompactNumber(changedFiles)} file${changedFiles === 1 ? "" : "s"}`;
  }
  return parts;
}
