import {
  normalizeToLf,
  resolveWorkspacePath,
  type SandboxFileSystem,
} from "@/chat/tools/sandbox/file-utils";
import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

interface EditReplacement {
  oldText: string;
  newText: string;
}

interface EditFileResult {
  content: [{ type: "text"; text: string }];
  details: {
    diff: string;
    first_changed_line?: number;
    ok: true;
    path: string;
    replacements: number;
  };
}

interface EditFileInput {
  path: string;
  edits: EditReplacement[];
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function detectLineEnding(value: string): "\r\n" | "\n" {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEndings(value: string, lineEnding: "\r\n" | "\n"): string {
  return lineEnding === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
}

function stripBom(value: string): { bom: string; text: string } {
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

function buildCompactDiff(
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

function validateAndApplyEdits(
  content: string,
  edits: EditReplacement[],
  filePath: string,
): { baseContent: string; newContent: string } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("editFile requires at least one edit.");
  }

  const normalizedEdits = edits.map((edit, index) => {
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw new Error(
        `edits[${index}].oldText must not be empty in ${filePath}.`,
      );
    }
    if (typeof edit.newText !== "string") {
      throw new Error(
        `edits[${index}].newText must be a string in ${filePath}.`,
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
      throw new Error(
        `Could not find edits[${index}] in ${filePath}. oldText must match exactly including whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of edits[${index}] in ${filePath}. Each oldText must be unique.`,
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
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge overlapping replacements into one edit.`,
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
    throw new Error(`No changes made to ${filePath}.`);
  }

  return { baseContent: content, newContent };
}

/** Accept common edit argument variants before Pi validates the canonical schema. */
export function prepareEditFileArguments(input: unknown): EditFileInput {
  if (!input || typeof input !== "object") {
    return input as EditFileInput;
  }

  const raw = { ...(input as Record<string, unknown>) };
  if (typeof raw.edits === "string") {
    try {
      raw.edits = JSON.parse(raw.edits);
    } catch {
      return raw as unknown as EditFileInput;
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
  return raw as unknown as EditFileInput;
}

/** Apply exact, ordered file replacements through the sandbox filesystem API. */
export async function editFile(params: {
  edits: EditReplacement[];
  fs: SandboxFileSystem;
  path: string;
}): Promise<EditFileResult> {
  const filePath = resolveWorkspacePath(params.path);
  const rawContent = await params.fs.readFile(filePath, { encoding: "utf8" });
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLf(text);
  const { baseContent, newContent } = validateAndApplyEdits(
    normalizedContent,
    params.edits,
    params.path,
  );
  await params.fs.writeFile(
    filePath,
    bom + restoreLineEndings(newContent, lineEnding),
    { encoding: "utf8" },
  );

  const diff = buildCompactDiff(baseContent, newContent);
  return {
    content: [
      {
        type: "text",
        text: `Successfully replaced ${params.edits.length} block(s) in ${params.path}.`,
      },
    ],
    details: {
      diff: diff.diff,
      first_changed_line: diff.firstChangedLine,
      ok: true,
      path: params.path,
      replacements: params.edits.length,
    },
  };
}

const editReplacementSchema = Type.Object(
  {
    oldText: Type.String({
      minLength: 1,
      description:
        "Exact text to replace. It must be unique in the original file and must not overlap another edit.",
    }),
    newText: Type.String({
      description: "Replacement text for this edit.",
    }),
  },
  { additionalProperties: false },
);

/** Create the sandbox edit tool definition exposed to the agent. */
export function createEditFileTool() {
  return tool({
    description:
      "Edit one sandbox workspace file with exact text replacements. Use for precise changes to existing files. Each oldText must match exactly, be unique, and not overlap another edit. Returns a diff.",
    promptSnippet: "existing-file exact edits; returns diff",
    promptGuidelines: [
      "prefer over writeFile for targeted changes",
      "oldText exact, unique, non-overlapping",
      "multiple same-file changes: one edits[] call",
    ],
    prepareArguments: prepareEditFileArguments,
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "Path to edit in the sandbox workspace.",
        }),
        edits: Type.Array(editReplacementSchema, {
          minItems: 1,
          description:
            "Exact replacements matched against the original file, not incrementally.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "editFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
