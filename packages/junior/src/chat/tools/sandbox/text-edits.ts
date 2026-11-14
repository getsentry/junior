import { structuredPatch } from "diff";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export interface TextReplacement {
  old_text: string;
  new_text: string;
}

export interface TextReplacementInput {
  edits: TextReplacement[];
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

const MAX_DIFF_LINE_CHARS = 4_000;

/** Preserve a text artifact's dominant line-ending style across rewrites. */
export function detectLineEnding(value: string): "\r\n" | "\n" {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

/** Restore normalized LF content to the caller's original line-ending style. */
export function restoreLineEndings(
  value: string,
  lineEnding: "\r\n" | "\n",
): string {
  return lineEnding === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
}

/** Keep UTF-8 BOM handling out of exact edit matching. */
export function stripBom(value: string): { bom: string; text: string } {
  return value.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: value.slice(1) }
    : { bom: "", text: value };
}

function countOccurrences(content: string, target: string): number {
  let count = 0;
  let start = 0;
  while (target.length > 0) {
    const index = content.indexOf(target, start);
    if (index === -1) break;
    count += 1;
    start = index + target.length;
  }
  return count;
}

function firstChangedLine(
  oldLines: string[],
  newLines: string[],
): number | undefined {
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }
  return undefined;
}

/**
 * Accept common exact-edit argument variants, such as the camelCase keys that
 * models often send, before schema validation.
 */
export function prepareTextReplacementArguments<T extends TextReplacementInput>(
  input: unknown,
): T {
  if (!input || typeof input !== "object") {
    return input as T;
  }

  const raw = { ...(input as Record<string, unknown>) };
  if (typeof raw.edits === "string") {
    try {
      raw.edits = JSON.parse(raw.edits);
    } catch {
      // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
      return raw as T;
    }
  }

  const edits: unknown[] = Array.isArray(raw.edits)
    ? Array.from<unknown>(raw.edits)
    : [];
  const oldText = raw.old_text ?? raw.oldText;
  const newText = raw.new_text ?? raw.newText;
  if (typeof oldText === "string" && typeof newText === "string") {
    edits.push({ old_text: oldText, new_text: newText });
  }

  if (edits.length > 0) {
    raw.edits = edits.map((edit) => {
      if (!edit || typeof edit !== "object") {
        return edit;
      }
      const record = edit as Record<string, unknown>;
      const { oldText, newText, ...rest } = record;
      return {
        ...rest,
        old_text: record.old_text ?? oldText,
        new_text: record.new_text ?? newText,
      };
    });
  }

  delete raw.oldText;
  delete raw.old_text;
  delete raw.newText;
  delete raw.new_text;
  // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
  return raw as T;
}

/** Build a small line-oriented diff that gives agents enough context to review edits. */
export function buildCompactDiff(
  oldContent: string,
  newContent: string,
): {
  diff: string;
  firstChangedLine?: number;
  truncated: boolean;
} {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  // Separate hunks keep unchanged lines between distant edits out of history.
  const { hunks } = structuredPatch(
    "",
    "",
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 3 },
  );
  const width = String(Math.max(oldLines.length, newLines.length)).length;
  const output: string[] = [];
  let lineTruncated = false;
  const pushLine = (line: string): void => {
    if (line.length > MAX_DIFF_LINE_CHARS) {
      line = `${line.slice(0, MAX_DIFF_LINE_CHARS)}... [line truncated]`;
      lineTruncated = true;
    }
    output.push(line);
  };

  let nextLine = 1;
  for (const hunk of hunks) {
    if (hunk.newStart > nextLine) {
      pushLine(` ${"".padStart(width)} ...`);
    }
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === "\\") {
        pushLine(line);
        continue;
      }
      const lineNumber = prefix === "-" ? oldLine : newLine;
      pushLine(
        `${prefix}${String(lineNumber).padStart(width)} ${line.slice(1)}`,
      );
      if (prefix !== "+") oldLine += 1;
      if (prefix !== "-") newLine += 1;
    }
    nextLine = newLine;
  }
  const newLineCount = newContent
    ? newLines.length - (newContent.endsWith("\n") ? 1 : 0)
    : 0;
  if (hunks.length > 0 && nextLine <= newLineCount) {
    pushLine(` ${"".padStart(width)} ...`);
  }

  return {
    diff: output.join("\n"),
    firstChangedLine: firstChangedLine(oldLines, newLines),
    truncated: lineTruncated,
  };
}

/** Apply exact replacements to normalized text after validating uniqueness and overlap. */
export function validateAndApplyTextEdits(
  content: string,
  edits: TextReplacement[],
  targetName: string,
): { baseContent: string; newContent: string } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new ToolInputError(`${targetName} requires at least one edit.`);
  }

  const normalizedEdits = edits.map((edit, index) => {
    if (typeof edit.old_text !== "string" || edit.old_text.length === 0) {
      throw new ToolInputError(
        `edits[${index}].old_text must not be empty in ${targetName}.`,
      );
    }
    if (typeof edit.new_text !== "string") {
      throw new ToolInputError(
        `edits[${index}].new_text must be a string in ${targetName}.`,
      );
    }
    return {
      oldText: normalizeToLf(edit.old_text),
      newText: normalizeToLf(edit.new_text),
    };
  });

  const matchedEdits: MatchedEdit[] = [];
  for (const [index, edit] of normalizedEdits.entries()) {
    const matchIndex = content.indexOf(edit.oldText);
    if (matchIndex === -1) {
      throw new ToolInputError(
        `Could not find edits[${index}] in ${targetName}. old_text must match exactly including whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences > 1) {
      throw new ToolInputError(
        `Found ${occurrences} occurrences of edits[${index}] in ${targetName}. Each old_text must be unique.`,
      );
    }
    matchedEdits.push({
      editIndex: index,
      matchIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (const [index, current] of matchedEdits.entries()) {
    const previous = matchedEdits[index - 1];
    if (!previous) {
      continue;
    }
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new ToolInputError(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${targetName}. Merge overlapping replacements into one edit.`,
      );
    }
  }

  let newContent = content;
  for (const edit of [...matchedEdits].reverse()) {
    newContent =
      newContent.slice(0, edit.matchIndex) +
      edit.newText +
      newContent.slice(edit.matchIndex + edit.matchLength);
  }

  if (newContent === content) {
    throw new ToolInputError(`No changes made to ${targetName}.`);
  }

  return { baseContent: content, newContent };
}
