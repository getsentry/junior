import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export interface TextReplacement {
  oldText: string;
  newText: string;
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
  oldContent: string,
  newContent: string,
): number | undefined {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }
  return undefined;
}

/** Accept common exact-edit argument variants before schema validation. */
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
      return raw as unknown as T;
    }
  }

  const edits = Array.isArray(raw.edits) ? [...raw.edits] : [];
  const oldText = raw.oldText ?? raw.old_text;
  const newText = raw.newText ?? raw.new_text;
  if (typeof oldText === "string" && typeof newText === "string") {
    edits.push({ oldText, newText });
  }

  if (edits.length > 0) {
    raw.edits = edits.map((edit) => {
      if (!edit || typeof edit !== "object") {
        return edit;
      }
      const record = edit as Record<string, unknown>;
      const { old_text, new_text, ...rest } = record;
      return {
        ...rest,
        oldText: record.oldText ?? old_text,
        newText: record.newText ?? new_text,
      };
    });
  }

  delete raw.oldText;
  delete raw.old_text;
  delete raw.newText;
  delete raw.new_text;
  return raw as unknown as T;
}

/** Build a small line-oriented diff that gives agents enough context to review edits. */
export function buildCompactDiff(
  oldContent: string,
  newContent: string,
): {
  diff: string;
  firstChangedLine?: number;
} {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const newContextEnd = Math.min(newLines.length - 1, newSuffix + 3);
  const oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + 3);
  const width = String(Math.max(oldLines.length, newLines.length)).length;
  const output: string[] = [];

  if (contextStart > 0) {
    output.push(` ${"".padStart(width)} ...`);
  }
  for (let index = contextStart; index < prefix; index += 1) {
    output.push(` ${String(index + 1).padStart(width)} ${oldLines[index]}`);
  }
  for (let index = prefix; index <= oldSuffix; index += 1) {
    output.push(`-${String(index + 1).padStart(width)} ${oldLines[index]}`);
  }
  for (let index = prefix; index <= newSuffix; index += 1) {
    output.push(`+${String(index + 1).padStart(width)} ${newLines[index]}`);
  }
  for (let index = newSuffix + 1; index <= newContextEnd; index += 1) {
    output.push(` ${String(index + 1).padStart(width)} ${newLines[index]}`);
  }
  if (
    newContextEnd < newLines.length - 1 ||
    oldContextEnd < oldLines.length - 1
  ) {
    output.push(` ${"".padStart(width)} ...`);
  }

  return {
    diff: output.join("\n"),
    firstChangedLine: firstChangedLine(oldContent, newContent),
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
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw new ToolInputError(
        `edits[${index}].oldText must not be empty in ${targetName}.`,
      );
    }
    if (typeof edit.newText !== "string") {
      throw new ToolInputError(
        `edits[${index}].newText must be a string in ${targetName}.`,
      );
    }
    return {
      oldText: normalizeToLf(edit.oldText),
      newText: normalizeToLf(edit.newText),
    };
  });

  const matchedEdits: MatchedEdit[] = [];
  for (let index = 0; index < normalizedEdits.length; index += 1) {
    const edit = normalizedEdits[index];
    const matchIndex = content.indexOf(edit.oldText);
    if (matchIndex === -1) {
      throw new ToolInputError(
        `Could not find edits[${index}] in ${targetName}. oldText must match exactly including whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences > 1) {
      throw new ToolInputError(
        `Found ${occurrences} occurrences of edits[${index}] in ${targetName}. Each oldText must be unique.`,
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
  for (let index = 1; index < matchedEdits.length; index += 1) {
    const previous = matchedEdits[index - 1];
    const current = matchedEdits[index];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new ToolInputError(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${targetName}. Merge overlapping replacements into one edit.`,
      );
    }
  }

  let newContent = content;
  for (let index = matchedEdits.length - 1; index >= 0; index -= 1) {
    const edit = matchedEdits[index];
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
