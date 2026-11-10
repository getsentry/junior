/**
 * Copy the code that each citation points at. The model cites line ranges and
 * never copies code, so a reader always sees what the provider returned.
 */
import type { WalkthroughDiffFile, WalkthroughDiffLine } from "./diff";
import {
  codeExcerptId,
  type WalkthroughCodeRef,
  type WalkthroughExcerpt,
} from "./schema";
import { contextFileKey } from "./validate";

const MAX_LINE_LENGTH = 400;

/**
 * Build one excerpt per distinct citation. Call this only after
 * `validateWalkthrough` passed, so every range resolves.
 *
 * `contextFiles` holds the text of files read at a PR head commit, keyed by
 * `contextFileKey`, for head-side citations outside the diff.
 */
export function buildWalkthroughExcerpts(
  refs: readonly WalkthroughCodeRef[],
  files: readonly WalkthroughDiffFile[],
  contextFiles: ReadonlyMap<string, string>,
): WalkthroughExcerpt[] {
  const excerpts = new Map<string, WalkthroughExcerpt>();
  for (const ref of refs) {
    const id = codeExcerptId(ref);
    if (excerpts.has(id)) continue;
    const lines = hunkLines(ref, files) ?? contextLines(ref, contextFiles);
    if (!lines) {
      throw new Error(`Citation ${id} does not resolve; validate first.`);
    }
    excerpts.set(id, {
      id,
      pr: ref.pr,
      path: ref.path,
      side: ref.side,
      start: ref.start,
      end: ref.end,
      lines: lines.map((line) => ({
        ...line,
        content: line.content.slice(0, MAX_LINE_LENGTH),
      })),
    });
  }
  return [...excerpts.values()];
}

/**
 * Lines of the hunk that holds the range. Lines from the other side that sit
 * between cited lines stay, so a head range still shows what it replaced.
 */
function hunkLines(
  ref: WalkthroughCodeRef,
  files: readonly WalkthroughDiffFile[],
): WalkthroughDiffLine[] | undefined {
  const file = files.find((f) => f.pr === ref.pr && f.path === ref.path);
  const hunk = file?.hunks.find((h) => {
    const range = h[ref.side];
    return range && ref.start >= range.start && ref.end <= range.end;
  });
  if (!hunk) return undefined;
  const lineNumber = (line: WalkthroughDiffLine) =>
    ref.side === "head" ? line.newLine : line.oldLine;
  const first = hunk.lines.findIndex((line) => lineNumber(line) === ref.start);
  const last = hunk.lines.findIndex((line) => lineNumber(line) === ref.end);
  return hunk.lines.slice(first, last + 1);
}

function contextLines(
  ref: WalkthroughCodeRef,
  contextFiles: ReadonlyMap<string, string>,
): WalkthroughDiffLine[] | undefined {
  const text = contextFiles.get(contextFileKey(ref.pr, ref.path));
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .slice(ref.start - 1, ref.end)
    .map((content, index) => ({
      kind: "context",
      content,
      newLine: ref.start + index,
    }));
}
