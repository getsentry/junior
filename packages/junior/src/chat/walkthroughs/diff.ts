/**
 * Turn provider diffs into what a Walkthrough may cite.
 *
 * Providers return one unified-diff patch per changed file. This parses each
 * patch into hunks with line numbers, and drops mechanical files (lockfiles,
 * generated code, pure renames, whitespace-only edits, and files with no
 * patch) so the model never reads them and never has to cover them.
 */
/** One changed file of a code change, as a provider returns it. */
export type WalkthroughChangedFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed";
  /** Unified diff. Missing for binary files and files too large to diff. */
  patch?: string;
};

/** One line of a diff hunk with its line number on each side it exists on. */
export type WalkthroughDiffLine = {
  kind: "add" | "remove" | "context";
  content: string;
  oldLine?: number;
  newLine?: number;
};

/** Inclusive line range on one side of a diff hunk. */
type WalkthroughLineRange = { start: number; end: number };

/**
 * One diff hunk. A side is missing when the hunk has no lines there, such as
 * the base side of a new file.
 */
export type WalkthroughHunk = {
  head?: WalkthroughLineRange;
  base?: WalkthroughLineRange;
  lines: WalkthroughDiffLine[];
};

/** A changed file that a Walkthrough may cite. */
export type WalkthroughDiffFile = {
  pr: number;
  path: string;
  hunks: WalkthroughHunk[];
};

export type WalkthroughSkipReason =
  | "generated"
  | "lockfile"
  | "no_diff"
  | "rename"
  | "whitespace";

/** Mechanical changes, counted per reason. Only the counts are shown. */
export type WalkthroughSkipped = {
  reason: WalkthroughSkipReason;
  files: number;
  lines: number;
};

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
const GENERATED_PATH =
  /(^|\/)(dist|__generated__|generated)\/|\.min\.(js|css)$|\.(pb|gen)\.[a-z]+$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one unified-diff patch into hunks with line numbers on both sides. */
export function parsePatch(patch: string): WalkthroughHunk[] {
  const hunks: WalkthroughHunk[] = [];
  let hunk: WalkthroughHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { lines: [] };
      if (oldCount > 0) {
        hunk.base = { start: oldLine, end: oldLine + oldCount - 1 };
      }
      if (newCount > 0) {
        hunk.head = { start: newLine, end: newLine + newCount - 1 };
      }
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = text[0];
    const content = text.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", content, newLine: newLine++ });
    } else if (marker === "-") {
      hunk.lines.push({ kind: "remove", content, oldLine: oldLine++ });
    } else if (marker === " ") {
      hunk.lines.push({
        kind: "context",
        content,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
    // "\ No newline at end of file" and trailing empty lines carry no code.
  }
  return hunks;
}

/**
 * Split one PR's changed files into the ones a Walkthrough may cite and
 * counts of the mechanical ones it skips.
 */
export function readWalkthroughDiff(
  pr: number,
  changed: readonly WalkthroughChangedFile[],
): { files: WalkthroughDiffFile[]; skipped: WalkthroughSkipped[] } {
  const files: WalkthroughDiffFile[] = [];
  const skipped = new Map<WalkthroughSkipReason, WalkthroughSkipped>();
  for (const file of changed) {
    const hunks = file.patch ? parsePatch(file.patch) : [];
    const reason = skipReason(file, hunks);
    if (reason) {
      const entry = skipped.get(reason) ?? { reason, files: 0, lines: 0 };
      entry.files += 1;
      entry.lines += changedLines(hunks);
      skipped.set(reason, entry);
      continue;
    }
    files.push({ pr, path: file.path, hunks });
  }
  return { files, skipped: [...skipped.values()] };
}

function skipReason(
  file: WalkthroughChangedFile,
  hunks: readonly WalkthroughHunk[],
): WalkthroughSkipReason | undefined {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  if (LOCKFILES.has(name)) return "lockfile";
  if (GENERATED_PATH.test(file.path) || hasGeneratedMarker(hunks)) {
    return "generated";
  }
  if (hunks.length === 0) {
    return file.status === "renamed" ? "rename" : "no_diff";
  }
  if (isWhitespaceOnly(hunks)) return "whitespace";
  return undefined;
}

/** Tools mark generated files with "@generated" near the top of the file. */
function hasGeneratedMarker(hunks: readonly WalkthroughHunk[]): boolean {
  return hunks.some((hunk) =>
    hunk.lines.some(
      (line) =>
        line.kind !== "remove" &&
        line.newLine !== undefined &&
        line.newLine <= 5 &&
        line.content.includes("@generated"),
    ),
  );
}

function isWhitespaceOnly(hunks: readonly WalkthroughHunk[]): boolean {
  const strip = (kind: WalkthroughDiffLine["kind"]) =>
    hunks
      .flatMap((hunk) => hunk.lines)
      .filter((line) => line.kind === kind)
      .map((line) => line.content)
      .join("")
      .replace(/\s+/g, "");
  return changedLines(hunks) > 0 && strip("add") === strip("remove");
}

function changedLines(hunks: readonly WalkthroughHunk[]): number {
  return hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.kind !== "context").length,
    0,
  );
}
